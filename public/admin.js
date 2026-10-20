
const socket = io();

const $ = (id) => document.getElementById(id);
const peers = new Map();

let currentRoom = null;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

function setStatus(message) {
  $("adminStatus").textContent = message;
}

function updateCount() {
  const n = peers.size;
  $("guestCount").textContent = `${n} guest${n === 1 ? "" : "s"}`;
}

function createGuestCard(id) {
  let card = document.getElementById(`guest-${id}`);
  if (card) return card;

  card = document.createElement("div");
  card.className = "guest-card";
  card.id = `guest-${id}`;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  const meta = document.createElement("div");
  meta.className = "guest-meta";

  const name = document.createElement("span");
  name.textContent = `Guest ${id.slice(0, 5)}`;

  const state = document.createElement("span");
  state.className = "connection-state";
  state.textContent = "Connecting...";

  meta.append(name, state);
  card.append(video, meta);
  $("guestGrid").append(card);

  return card;
}

function removePeer(id) {
  const entry = peers.get(id);

  if (entry) {
    entry.pc.ontrack = null;
    entry.pc.onicecandidate = null;
    entry.pc.close();
    peers.delete(id);
  }

  document.getElementById(`guest-${id}`)?.remove();
  updateCount();
}

function getPeer(id) {
  if (peers.has(id)) return peers.get(id);

  const pc = new RTCPeerConnection(rtcConfig);
  const entry = {
    pc,
    pendingIce: [],
    remoteSet: false
  };

  peers.set(id, entry);

  const card = createGuestCard(id);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        to: id,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    const video = card.querySelector("video");

    if (event.streams[0]) {
      video.srcObject = event.streams[0];
    } else {
      if (!video.srcObject) {
        video.srcObject = new MediaStream();
      }
      video.srcObject.addTrack(event.track);
    }

    video.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const label = card.querySelector(".connection-state");
    if (label) label.textContent = pc.connectionState;

    if (pc.connectionState === "failed") {
      setStatus(
        "Connection failed. This network may require a TURN server."
      );
    }
  };

  updateCount();
  return entry;
}

async function flushIce(entry) {
  while (entry.remoteSet && entry.pendingIce.length) {
    const candidate = entry.pendingIce.shift();

    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("ICE candidate error:", error);
    }
  }
}

$("loginForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const password = $("password").value;
  $("loginStatus").textContent = "Checking password...";

  socket.emit("admin-login", password, (result) => {
    if (!result?.ok) {
      $("loginStatus").textContent =
        result?.error || "Login failed.";
      return;
    }

    $("loginPanel").classList.add("hidden");
    $("adminPanel").classList.remove("hidden");
    setStatus("Logged in. Generate a guest link.");
  });
});

$("createBtn").addEventListener("click", () => {
  $("createBtn").disabled = true;

  socket.emit("create-room", (result) => {
    $("createBtn").disabled = false;

    if (!result?.ok) {
      setStatus(result?.error || "Could not create session.");
      return;
    }

    currentRoom = result.roomId;

    const guestUrl = new URL("/guest", location.origin);
    guestUrl.searchParams.set("room", currentRoom);

    $("inviteLink").value = guestUrl.href;
    $("linkArea").classList.remove("hidden");
    $("endBtn").classList.remove("hidden");

    setStatus("Session live. Share the guest link.");
  });
});

$("copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("inviteLink").value);
    $("copyBtn").textContent = "Copied!";
  } catch {
    $("inviteLink").select();
    setStatus("Press Ctrl+C to copy the selected link.");
  }
});

$("endBtn").addEventListener("click", () => {
  socket.emit("end-session");

  for (const id of [...peers.keys()]) {
    removePeer(id);
  }

  currentRoom = null;
  $("linkArea").classList.add("hidden");
  $("endBtn").classList.add("hidden");

  setStatus("Session ended. Generate a new link to start again.");
});

socket.on("guest-joined", ({ guestId }) => {
  createGuestCard(guestId);
  setStatus("Guest joined. Connecting video...");
});

socket.on("offer", async ({ from, description }) => {
  if (!currentRoom) return;

  const entry = getPeer(from);

  try {
    await entry.pc.setRemoteDescription(description);
    entry.remoteSet = true;

    await flushIce(entry);

    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);

    socket.emit("answer", {
      to: from,
      description: entry.pc.localDescription
    });

    setStatus("Connecting to guest...");
  } catch (error) {
    console.error(error);
    setStatus(`Connection error: ${error.message}`);
  }
});

socket.on("ice-candidate", async ({ from, candidate }) => {
  const entry = getPeer(from);

  if (entry.remoteSet) {
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("ICE candidate error:", error);
    }
  } else {
    entry.pendingIce.push(candidate);
  }
});

socket.on("guest-left", ({ guestId, count }) => {
  removePeer(guestId);
  $("guestCount").textContent = `${count} guest${count === 1 ? "" : "s"}`;
  setStatus("A guest left.");
});

socket.on("session-ended", () => {
  for (const id of [...peers.keys()]) {
    removePeer(id);
  }

  currentRoom = null;
  $("linkArea").classList.add("hidden");
  $("endBtn").classList.add("hidden");
  setStatus("Session ended.");
});

socket.on("connect_error", () => {
  $("loginStatus").textContent =
    "Server connection failed. Check that npm start is running.";
});
