const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require('mongodb');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Production-Ready: Using Environment Variables for Secrets ---
// We will set these variables in our hosting environment (Render)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const MONGO_CONNECTION_STRING = process.env.MONGO_CONNECTION_STRING;
const SESSION_SECRET = process.env.SESSION_SECRET || 'a default secret for local development';
// ----------------------------------------------------------------

if (!GOOGLE_CLIENT_ID || !MONGO_CONNECTION_STRING) {
    console.error("\n*** ERROR: Missing critical environment variables. Make sure GOOGLE_CLIENT_ID and MONGO_CONNECTION_STRING are set. ***\n");
    // In a real production environment, you might not want to exit, but for this project it's a clear indicator.
    // process.exit(1); 
}

const client = new MongoClient(MONGO_CONNECTION_STRING);
let db, usersCollection, friendshipsCollection, scoresCollection;
const onlineUsers = {}; 
const pendingGames = {}; 

const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: 'auto' } // 'auto' is good for Render's proxy
});
app.use(express.json());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
io.engine.use(sessionMiddleware);

passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, callbackURL: "/auth/google/callback"
}, async (accessToken, refreshToken, profile, done) => {
    // ... (The rest of the passport logic is identical to before)
    let user = await usersCollection.findOne({ googleId: profile.id });
    if (!user) {
        const result = await usersCollection.insertOne({
            googleId: profile.id, displayName: profile.displayName, customUsername: profile.displayName, wins: 0, createdAt: new Date()
        });
        user = await usersCollection.findOne({ _id: result.insertedId });
    }
    return done(null, user);
}));

passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(id) });
    done(null, user);
});

// --- HTTP Routes ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => {
    if (req.user && req.user.socketId) delete onlineUsers[req.user.socketId];
    req.logout(() => res.redirect('/'));
});
app.get('/api/user', (req, res) => req.isAuthenticated() ? res.json(req.user) : res.status(401).json({ message: 'Not Authenticated' }));
app.use(express.static('public'));

// --- Socket.IO Connections ---
// ... (The entire io.on('connection', ...) block is identical to before)
io.on('connection', async (socket) => {
    const user = await getSocketUser(socket);
    if (user) {
        onlineUsers[socket.id] = { ...user, socketId: socket.id };
        if (!user.isGuest) await usersCollection.updateOne({_id: user._id}, {$set: {socketId: socket.id}});
        console.log(`User connected: ${user.customUsername || user.displayName} (${socket.id})`);
    }

    socket.on('guestLogin', () => {
        const guestId = `guest_${new ObjectId()}`;
        const guestUser = { _id: guestId, customUsername: `Guest-${guestId.slice(-4)}`, isGuest: true };
        onlineUsers[socket.id] = { ...guestUser, socketId: socket.id };
        socket.emit('loginSuccess', guestUser);
    });

    socket.on('requestInitialData', async () => {
        const user = onlineUsers[socket.id];
        if (!user || user.isGuest) return;
        const friendships = await friendshipsCollection.find({ $or: [{ requesterId: user._id }, { recipientId: user._id }] }).toArray();
        const friendIds = friendships.map(f => f.requesterId.equals(user._id) ? f.recipientId : f.requesterId);
        const friends = await usersCollection.find({ _id: { $in: friendIds } }).toArray();
        const onlineFriendSockets = Object.values(onlineUsers).filter(u => !u.isGuest && friendIds.some(fId => fId.equals(u._id)));
        socket.emit('friendsList', { friends, onlineFriendIds: onlineFriendSockets.map(u => u._id.toString()) });
    });

    socket.on('addFriend', async (friendId) => {
        const requester = onlineUsers[socket.id];
        if (!requester || requester.isGuest || requester._id.toString() === friendId) return;
        const recipient = await usersCollection.findOne({ _id: new ObjectId(friendId) });
        if (!recipient) return;
        await friendshipsCollection.insertOne({ requesterId: requester._id, recipientId: recipient._id, status: 'accepted' });
        socket.emit('friendAdded', recipient);
        if (recipient.socketId) io.to(recipient.socketId).emit('friendAdded', requester);
    });
    
    socket.on('sendInvite', async ({ toUserId }) => {
        const sender = onlineUsers[socket.id];
        const recipientSocket = Object.values(onlineUsers).find(u => u._id.toString() === toUserId);
        if (sender && recipientSocket) {
            io.to(recipientSocket.socketId).emit('inviteReceived', { fromId: sender._id.toString(), fromName: sender.customUsername });
        }
    });

    socket.on('acceptInvite', (senderId) => {
        const accepter = onlineUsers[socket.id];
        const senderSocket = Object.values(onlineUsers).find(u => u._id.toString() === senderId);
        if (!accepter || !senderSocket) return;
        const gameId = new ObjectId().toString();
        pendingGames[gameId] = {
            player1: { id: senderSocket._id, socketId: senderSocket.socketId, name: senderSocket.customUsername, difficulty: null },
            player2: { id: accepter._id, socketId: accepter.socketId, name: accepter.customUsername, difficulty: null }
        };
        io.to(senderSocket.socketId).to(accepter.socketId).emit('showDifficultySelect', { gameId });
    });

    socket.on('difficultySelected', ({ gameId, difficulty }) => {
        const game = pendingGames[gameId];
        const player = onlineUsers[socket.id];
        if (!game || !player) return;

        const isPlayer1 = game.player1.id.toString() === player._id.toString();
        if (isPlayer1) game.player1.difficulty = difficulty;
        else game.player2.difficulty = difficulty;

        const { player1, player2 } = game;
        io.to(player1.socketId).emit('updateDifficultyChoices', { myChoice: player1.difficulty, opponentChoice: player2.difficulty, opponentName: player2.name });
        io.to(player2.socketId).emit('updateDifficultyChoices', { myChoice: player2.difficulty, opponentChoice: player1.difficulty, opponentName: player1.name });

        if (player1.difficulty && player2.difficulty) {
            io.to(player1.socketId).emit('gameStart', { gameId, opponentName: player2.name, difficulty: player1.difficulty });
            io.to(player2.socketId).emit('gameStart', { gameId, opponentName: player1.name, difficulty: player2.difficulty });
            delete pendingGames[gameId];
        }
    });
    
    socket.on('gameOver', async ({ score, mode }) => {
        const user = onlineUsers[socket.id];
        if (!user || user.isGuest) return;
        if (mode === 'single') {
            await scoresCollection.insertOne({ userId: user._id, username: user.customUsername, score, mode, createdAt: new Date() });
        }
    });
    
    socket.on('getLeaderboards', async () => {
        const singlePlayer = await scoresCollection.find({ mode: 'single' }).sort({ score: -1 }).limit(10).toArray();
        const multiPlayer = await usersCollection.find({ wins: { $gt: 0 } }).sort({ wins: -1 }).limit(10).toArray();
        socket.emit('leaderboards', { singlePlayer, multiPlayer });
    });

    socket.on('disconnect', async () => {
        const user = onlineUsers[socket.id];
        if (user && !user.isGuest) await usersCollection.updateOne({ _id: user._id }, { $unset: { socketId: "" } });
        delete onlineUsers[socket.id];
        console.log(`User disconnected: ${user ? user.customUsername : 'Unknown'}`);
    });
});


async function getSocketUser(socket) {
    // ... (This function is identical to before)
    const session = socket.request.session;
    if (session && session.passport && session.passport.user) {
        const userId = session.passport.user;
        return await usersCollection.findOne({ _id: new ObjectId(userId) });
    }
    return null;
}

// --- Dynamic Port for Hosting ---
const PORT = process.env.PORT || 3000;

async function main() {
    try {
        await client.connect();
        db = client.db("flappybird");
        usersCollection = db.collection("users");
        friendshipsCollection = db.collection("friendships");
        scoresCollection = db.collection("scores");
        console.log("Successfully connected to MongoDB Atlas!");
        server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
    } catch (err) { console.error("Could not connect to MongoDB Atlas.", err); process.exit(1); }
}

main();

