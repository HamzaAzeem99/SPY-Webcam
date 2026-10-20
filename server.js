
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const ADMIN_PASSWORD = "hamza123";

if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD set karo, phir npm start chalao.");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/admin"));
app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);
app.get("/guest", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "guest.html"))
);

const rooms = new Map();
const MAX_GUESTS = 8;

io.on("connection", (socket) => {
  socket.on("admin-login", (password, callback) => {
    if (typeof callback !== "function") return;

    if (
      typeof password !== "string" ||
      password !== ADMIN_PASSWORD
    ) {
      return callback({
        ok: false,
        error: "Incorrect password."
      });
    }

    socket.data.adminAuthenticated = true;
    callback({ ok: true });
  });

  socket.on("create-room", (callback) => {
    if (typeof callback !== "function") return;

    if (!socket.data.adminAuthenticated) {
      return callback({
        ok: false,
        error: "Please sign in first."
      });
    }

    if (socket.data.roomId) leaveRoom(socket);

    const roomId = crypto.randomBytes(16).toString("hex");

    rooms.set(roomId, {
      adminId: socket.id,
      guests: new Set()
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "admin";

    callback({ ok: true, roomId });
  });

  socket.on("join-room", (roomId, callback) => {
    if (typeof callback !== "function") return;

    const room = rooms.get(roomId);

    if (!room || !io.sockets.sockets.has(room.adminId)) {
      return callback({
        ok: false,
        error: "Session nahi mil raha. Admin se new link lo."
      });
    }

    if (room.guests.size >= MAX_GUESTS) {
      return callback({
        ok: false,
        error: "Session full hai."
      });
    }

    if (socket.data.roomId) leaveRoom(socket);

    room.guests.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "guest";

    callback({ ok: true, adminId: room.adminId });

    io.to(room.adminId).emit("guest-joined", {
      guestId: socket.id,
      count: room.guests.size
    });
  });

  socket.on("offer", ({ to, description } = {}) => {
    const room = rooms.get(socket.data.roomId);

    if (
      !room ||
      socket.data.role !== "guest" ||
      to !== room.adminId ||
      !description
    ) return;

    io.to(to).emit("offer", {
      from: socket.id,
      description
    });
  });

  socket.on("answer", ({ to, description } = {}) => {
    const room = rooms.get(socket.data.roomId);

    if (
      !room ||
      socket.data.role !== "admin" ||
      !room.guests.has(to) ||
      !description
    ) return;

    io.to(to).emit("answer", {
      from: socket.id,
      description
    });
  });

  socket.on("ice-candidate", ({ to, candidate } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !candidate || !to) return;

    const allowed =
      (socket.data.role === "admin" && room.guests.has(to)) ||
      (socket.data.role === "guest" && room.adminId === to);

    if (allowed) {
      io.to(to).emit("ice-candidate", {
        from: socket.id,
        candidate
      });
    }
  });

  socket.on("leave-room", () => leaveRoom(socket));

  socket.on("end-session", () => {
    if (
      !socket.data.adminAuthenticated ||
      socket.data.role !== "admin"
    ) return;

    const room = rooms.get(socket.data.roomId);
    if (!room) return;

    for (const guestId of room.guests) {
      io.to(guestId).emit("session-ended");

      const guest = io.sockets.sockets.get(guestId);
      if (guest) {
        guest.leave(socket.data.roomId);
        guest.data.roomId = null;
        guest.data.role = null;
      }
    }

    socket.leave(socket.data.roomId);
    rooms.delete(socket.data.roomId);
    socket.data.roomId = null;
    socket.data.role = null;
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  const role = socket.data.role;

  if (!roomId || !role) return;

  const room = rooms.get(roomId);

  if (room) {
    if (role === "admin") {
      for (const guestId of room.guests) {
        io.to(guestId).emit("session-ended");

        const guest = io.sockets.sockets.get(guestId);
        if (guest) {
          guest.leave(roomId);
          guest.data.roomId = null;
          guest.data.role = null;
        }
      }

      rooms.delete(roomId);
    } else {
      room.guests.delete(socket.id);

      io.to(room.adminId).emit("guest-left", {
        guestId: socket.id,
        count: room.guests.size
      });
    }
  }

  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.role = null;
}

const PORT = process.env.PORT || "https://callwebcam.vercel.app/";

server.listen(PORT, () => {
  console.log(`VideoCall: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(`Guest: http://localhost:${PORT}/guest`);
});
