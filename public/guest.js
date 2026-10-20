
const socket = io();

const $ = (id) => document.getElementById(id);
const button = $("guestActionBtn");
const roomId = new URLSearchParams(location.search).get("room");

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

let localStream = null;
let pc = null;
let adminId = null;
let joined = false;
let pendingIce = [];
let remoteSet = false;
let busy = false;

function setStatus(message) {
  $("guestStatus").textContent = message;
}

function stopMedia() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = null;
}

function cleanup(message) {
  if (pc) {
    pc.onicecandidate = null;
    pc.close();
  }

  pc = null;
  stopMedia();
  joined = false;
  busy = false;
  pendingIce = [];
  remoteSet = false;

  button.disabled = false;
  button.textContent = "Join Call";
  setStatus(message);
}

async function flushIce() {
  while (pc && remoteSet && pendingIce.length) {
    const candidate = pendingIce.shift();

    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("ICE candidate error:", error);
    }
  }
}

button.addEventListener("click", async () => {
  if (busy) return;

  if (joined) {
    socket.emit("leave-room");
    cleanup("You left the call.");
    return;
  }

  if (!roomId) {
    setStatus("Invalid guest link. Ask the admin for the full link.");
    return;
  }

  if (!socket.connected) {
    setStatus("Connecting to server. Please try again.");
    return;
  }

  busy = true;
  button.disabled = true;
  setStatus("Requesting camera and microphone permission...");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    // Intentionally no video element: guest's local preview stays hidden.

    if (!socket.connected) {
      throw new Error("Server disconnected. Please try again.");
    }

    socket.emit("join-room", roomId, async (result) => {
      if (!result?.ok) {
        cleanup(result?.error || "Could not join the call.");
        return;
      }

      adminId = result.adminId;
      joined = true;
      busy = false;

      button.disabled = false;
      button.textContent = "Leave Call";

      pc = new RTCPeerConnection(rtcConfig);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", {
            to: adminId,
            candidate: event.candidate
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (!pc || !joined) return;

        const state = pc.connectionState;

        if (state === "connected") {
          setStatus("Connected. Your camera and microphone are live.");
        } else if (state === "failed") {
          setStatus("Connection failed. Try another network.");
        } else {
          setStatus(`Call status: ${state}`);
        }
      };

      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("offer", {
          to: adminId,
          description: pc.localDescription
        });

        setStatus("Joined. Connecting to the admin...");
      } catch (error) {
        console.error(error);
        socket.emit("leave-room");
        cleanup(`Could not start the call: ${error.message}`);
      }
    });
  } catch (error) {
    console.error(error);

    cleanup(
      error.name === "NotAllowedError"
        ? "Camera/mic permission denied. Allow access and try again."
        : `Error: ${error.message}`
    );
  }
});

socket.on("answer", async ({ description }) => {
  if (!pc || !joined) return;

  try {
    await pc.setRemoteDescription(description);
    remoteSet = true;
    await flushIce();
  } catch (error) {
    console.error(error);
    setStatus(`Connection error: ${error.message}`);
  }
});

socket.on("ice-candidate", async ({ candidate }) => {
  if (!pc || !joined) return;

  if (remoteSet) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("ICE candidate error:", error);
    }
  } else {
    pendingIce.push(candidate);
  }
});

socket.on("session-ended", () => {
  cleanup("The admin ended the session.");
});

socket.on("disconnect", () => {
  if (joined || localStream) {
    cleanup("Server disconnected. Join again when the server is available.");
  }
});

socket.on("connect_error", () => {
  setStatus("Cannot connect to server. Check your connection.");
});
