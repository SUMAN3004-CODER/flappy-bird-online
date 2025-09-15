const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require('mongodb');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path'); // Added for reliability

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Environment Variables ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const MONGO_CONNECTION_STRING = process.env.MONGO_CONNECTION_STRING;
const SESSION_SECRET = process.env.SESSION_SECRET || 'a default secret for local development';

// --- Critical Server Settings ---
app.set('trust proxy', 1);
if (!GOOGLE_CLIENT_ID || !MONGO_CONNECTION_STRING || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET) {
    console.error("\n*** FATAL ERROR: One or more required environment variables are missing. ***\n");
    console.error("Please check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MONGO_CONNECTION_STRING, and SESSION_SECRET on Render.");
    // We don't exit here so Render logs can be seen, but the app will not function.
}

// --- Database Connection ---
const client = new MongoClient(MONGO_CONNECTION_STRING);
let db, usersCollection, friendshipsCollection, scoresCollection;
const onlineUsers = {}; 
const pendingGames = {}; 

// --- Middleware Setup ---
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: 'auto' }
});
app.use(express.json());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
io.engine.use(sessionMiddleware);

// --- Passport (Authentication) Setup ---
passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, callbackURL: "/auth/google/callback"
}, async (accessToken, refreshToken, profile, done) => {
    try {
        let user = await usersCollection.findOne({ googleId: profile.id });
        if (!user) {
            const result = await usersCollection.insertOne({
                googleId: profile.id, displayName: profile.displayName, customUsername: profile.displayName, wins: 0, createdAt: new Date()
            });
            user = await usersCollection.findOne({ _id: result.insertedId });
        }
        return done(null, user);
    } catch (err) {
        console.error("Error during Google Strategy user lookup:", err);
        return done(err, null);
    }
}));

passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await usersCollection.findOne({ _id: new ObjectId(id) });
        done(null, user);
    } catch (err) {
        console.error("Error during deserializeUser:", err);
        done(err, null);
    }
});

// --- HTTP Routes ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => {
    if (req.user && req.user.socketId) delete onlineUsers[req.user.socketId];
    req.logout(() => res.redirect('/'));
});
app.get('/api/user', (req, res) => req.isAuthenticated() ? res.json(req.user) : res.status(401).json({ message: 'Not Authenticated' }));

// --- Serve Static Files (HTML, CSS, client.js) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Socket.IO Real-time Logic ---
io.on('connection', async (socket) => {
    // ... [The entire io.on('connection', ...) block is the same as the last version you had, no changes needed inside it]
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

    socket.on('setUsername', async (username) => {
        const user = onlineUsers[socket.id];
        if (user && !user.isGuest) {
            await usersCollection.updateOne({ _id: user._id }, { $set: { customUsername: username } });
            user.customUsername = username; // Update local record
            socket.emit('loginSuccess', user);
        }
    });

    socket.on('requestInitialData', async () => {
        const user = onlineUsers[socket.id];
        if (!user || user.isGuest) return;
        const friendships = await friendshipsCollection.find({ $or: [{ requesterId: user._id }, { recipientId: user._id }] }).toArray();
        const friendIds = friendships.map(f => f.requesterId.equals(user._id) ? f.recipientId : f.requesterId);
        const friends = await usersCollection.find({ _id: { $in: friendIds } }).project({ customUsername: 1, _id: 1 }).toArray();
        const onlineFriendSockets = Object.values(onlineUsers).filter(u => !u.isGuest && friendIds.some(fId => fId.equals(u._id)));
        socket.emit('friendsList', { friends, onlineFriendIds: onlineFriendSockets.map(u => u._id.toString()) });
    });

    socket.on('addFriend', async (friendId) => {
        try {
            const requester = onlineUsers[socket.id];
            if (!requester || requester.isGuest || requester._id.toString() === friendId) return;
            const recipient = await usersCollection.findOne({ _id: new ObjectId(friendId) });
            if (!recipient) return;
            await friendshipsCollection.insertOne({ requesterId: requester._id, recipientId: recipient._id, status: 'accepted' });
            socket.emit('friendAdded', { _id: recipient._id, customUsername: recipient.customUsername });
            if (recipient.socketId && onlineUsers[recipient.socketId]) {
                io.to(recipient.socketId).emit('friendAdded', { _id: requester._id, customUsername: requester.customUsername });
            }
        } catch (err) { console.error("Error adding friend:", err); }
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
        io.to(senderSocket.socketId).emit('showDifficultySelect', { gameId });
        io.to(accepter.socketId).emit('showDifficultySelect', { gameId });
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
    
    socket.on('scoreUpdate', (score) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const game = Object.values(pendingGames).find(g => g.player1.id.equals(user._id) || g.player2.id.equals(user._id));
        if (!game) return; // This logic needs to be improved for active games
        const opponent = game.player1.id.equals(user._id) ? game.player2 : game.player1;
        io.to(opponent.socketId).emit('opponentScoreUpdate', score);
    });

    socket.on('gameOver', async ({ score, mode, won }) => {
        const user = onlineUsers[socket.id];
        if (!user || user.isGuest) return;
        if (mode === 'single') {
            await scoresCollection.insertOne({ userId: user._id, username: user.customUsername, score, mode, createdAt: new Date() });
        } else if (mode === 'multi' && won) {
            await usersCollection.updateOne({ _id: user._id }, { $inc: { wins: 1 }});
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
        console.log(`User disconnected: ${user ? (user.customUsername || 'Guest') : 'Unknown'}`);
    });
});


async function getSocketUser(socket) {
    try {
        const session = socket.request.session;
        if (session && session.passport && session.passport.user) {
            const userId = session.passport.user;
            return await usersCollection.findOne({ _id: new ObjectId(userId) });
        }
    } catch (err) {
        console.error("Error in getSocketUser:", err);
    }
    return null;
}

const PORT = process.env.PORT || 3000;
async function main() {
    try {
        await client.connect();
        db = client.db("flappybird"); // Or your preferred db name
        usersCollection = db.collection("users");
        friendshipsCollection = db.collection("friendships");
        scoresCollection = db.collection("scores");
        console.log("Successfully connected to MongoDB Atlas!");
        server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
    } catch (err) {
        console.error("Could not connect to MongoDB Atlas.", err);
        process.exit(1);
    }
}

main();

