import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

server.listen(8000, () => {
    console.log("Listening on port 8000");
})


const io = new Server(server, {
    cors: { origin: "http://localhost:5173", methods: ['GET', 'POST'] },
});


// Maps socker ids to user ids
const SOCKET_TO_USER = {};

io.on("connect", (socket) => {
    // Should not register event handlers inside connect
    // https://socket.io/docs/v4/client-api/#event-connect
    console.log(`CONNECT => ${socket.id}`);

    socket.on("join", ({ user, room }) => {
        Object.keys(SOCKET_TO_USER).forEach((peerSocketId) => {
            // A client connecting to itself would cause an infinite loop.
            // Because useEffect triggers twice, this bug will occur without this line.
            if (socket.id == peerSocketId) {
                return;
            }

            // Joiner makes an offer to the new client
            console.log(`ADD_CLIENT => ${user} offering ${SOCKET_TO_USER[peerSocketId]}`);

            socket.emit("add_client", {
                currentSocketId: socket.id,
                currentUserId: SOCKET_TO_USER[socket.id],
                peerSocketId: peerSocketId,
                peerUserId: SOCKET_TO_USER[peerSocketId],
                offer: true
            });

            // Clients receiver offer from joiner
            io.to(peerSocketId).emit("add_client", {
                currentSocketId: peerSocketId,
                currentUserId: SOCKET_TO_USER[peerSocketId],
                peerSocketId: socket.id,
                peerUserId: SOCKET_TO_USER[socket.id],
                offer: false
            });
        })

        SOCKET_TO_USER[socket.id] = user;
    });

    socket.on("relay_sdp", ({ currentSocketId, peerSocketId, sessionDescription }) => {
        console.log(`RELAY SDP => ${currentSocketId} to ${peerSocketId}`);
        console.log(sessionDescription);

        io.to(peerSocketId).emit("session_description", {
            currentSocketId: peerSocketId,
            peerSocketId: currentSocketId,
            sessionDescription
        });
    });

    // Forward the ice candidate to the peer
    socket.on("relay_ice", ({ currentSocketId, peerSocketId, iceCandidate }) => {
        console.log(`RELAY_ICE => ${currentSocketId} to ${peerSocketId}`);
        // console.log(iceCandidate);

        io.to(peerSocketId).emit("ice_candidate", {
            currentSocketId: peerSocketId,
            peerSocketId: currentSocketId,
            iceCandidate: iceCandidate
        });
    });
})