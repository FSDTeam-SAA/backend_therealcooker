import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import router from "./mainroute/index.js";
import { createServer } from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { notificationRoom, setSocketServer } from "./utils/socket.js";
import { User } from "./model/user.model.js";

import globalErrorHandler from "./middleware/globalErrorHandler.js";
import notFound from "./middleware/notFound.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.set("trust proxy", true);

const server = createServer(app);
export const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
setSocketServer(io);

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Unauthorized"));

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded._id).select("_id");
    if (!user || !(await User.isOTPVerified(user._id))) {
      return next(new Error("Unauthorized"));
    }

    socket.data.userId = user._id.toString();
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

// Track active sockets to force-close them on restart
const activeSockets = new Set();
server.on("connection", (socket) => {
  activeSockets.add(socket);
  socket.once("close", () => activeSockets.delete(socket));
});

app.use(
  cors({
    credentials: true,
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);

// The `verify` hook stashes the raw request bytes on req.rawBody alongside
// the normally-parsed req.body. Needed for routes that must verify an HMAC
// signature computed over the exact bytes sent (e.g. the Dojah KYC
// webhook) — re-serializing the parsed JSON can produce a byte-different
// string and make a genuine signature look invalid.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "public/uploads")));

// Mount the main router
app.use("/api/v1", router);

// Basic route for testing
app.get("/", (req, res) => {
  res.send("Server is running...!!");
});

app.use(globalErrorHandler);
app.use(notFound);

io.on("connection", (socket) => {
  console.log("A client connected:", socket.id);

  socket.on("joinChatRoom", (userId) => {
    const authenticatedUserId = socket.data.userId;
    if (authenticatedUserId && String(userId) === authenticatedUserId) {
      socket.join(`chat_${authenticatedUserId}`);
      console.log(
        `Client ${socket.id} joined user room: ${authenticatedUserId}`
      );
    }
  });

  socket.on("joinNotificationRoom", (userId) => {
    const authenticatedUserId = socket.data.userId;
    if (authenticatedUserId && String(userId) === authenticatedUserId) {
      socket.join(notificationRoom(authenticatedUserId));
      console.log(
        `Client ${socket.id} joined notification room: ${authenticatedUserId}`
      );
    }
  });

  socket.on("joinAlerts", () => {
    socket.join("alerts");
    console.log(`Client ${socket.id} joined alerts room`);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5011;

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");

    // ONLY call server.listen ONCE here:
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
};

startServer();

// --- Graceful Shutdown ---
// The port stays bound until every socket is gone, so keep-alive and websocket
// connections are destroyed explicitly. A hard timeout guarantees the process
// exits even if a close callback never fires — a hung process holding the port
// is what causes EADDRINUSE on the next restart.

let isShuttingDown = false;

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${signal} received. Shutting down...`);

  const forceExit = setTimeout(() => {
    console.error("Shutdown timed out after 5s. Forcing exit.");
    process.exit(0);
  }, 5000);
  forceExit.unref();

  try {
    io.disconnectSockets(true);
    io.close();

    for (const socket of activeSockets) socket.destroy();
    activeSockets.clear();

    await new Promise((resolve) => server.close(resolve));

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  } catch (err) {
    console.error("Error during shutdown:", err);
  }

  clearTimeout(forceExit);
  process.exit(0);
};

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `\n❌ Port ${PORT} is already in use.\n` +
        `   Free it with:  npm run stop\n`
    );
    process.exit(1);
  }
  console.error("Server error:", error);
  process.exit(1);
});

// SIGHUP matters here: when the terminal window dies, an unhandled SIGHUP is how
// nodemon and its child end up orphaned (reparented to PID 1) while still
// holding the port and watching files.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGUSR2"]) {
  process.once(signal, () => shutdown(signal));
}

process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED REJECTION:", error);
  shutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
  shutdown("uncaughtException");
});
