import { useCallback, useEffect, useRef, useState } from "react"
import { Socket, io } from "socket.io-client"
import Video from "./Video";

const CONNECTION_OPTIONS: {
    forceNew: boolean,
    reconnectionAttempts: number,
    timeout: number,
    transports: string[]
} = {
    forceNew: true,
    reconnectionAttempts: Infinity,
    timeout: 10000,
    transports: ['websocket'],
};

// Free stun servers from google
const ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com" },
    { urls: "stun:stun1.l.google.com" },
    { urls: "stun:stun2.l.google.com" },
    { urls: "stun:stun3.l.google.com" },
    { urls: "stun:stun4.l.google.com" },

];

export const initSocket = () => io("localhost:8000", CONNECTION_OPTIONS);

const Room = () => {
    const socket = useRef<Socket | null>(null);

    // Maps SocketIds to PeerConnections
    const [peerConnections, setPeerConnections] = useState<{ [k: string]: RTCPeerConnection | undefined }>({});

    // Map UserId to Streams
    const [mediaStreams, setMediaStreams] = useState<{ [k: string]: MediaStream }>({});

    // Store the current connections' local media streams
    const [localMediaStream, setLocalMediaStream] = useState<MediaStream | null>(null);

    useEffect(() => {
        socket.current = initSocket();
        // Initialises the user's media stream
        const initialiseMedia = async () => {
            await initialiseLocalAV();

            // NOTE: socket.current.id does not exist yet because no join event has occurred yet...
            setPeerConnections({
                ...peerConnections,
                [socket.current!.id]: new RTCPeerConnection({
                    iceServers: ICE_SERVERS,
                })
            });

            socket.current!.emit("join", { user: window.location.pathname.split('/')[1], room: "Room" });
        }

        initialiseMedia();

        return () => {
            // TODO: Handle leave event...
            socket.current?.close();
        }
    }, []);


    const initialiseLocalAV = async () => {
        try {
            // GET USER AUDIO DEVICE
            setLocalMediaStream(await navigator.mediaDevices.getUserMedia({
                video: true
            }));

            // TODO: At this point, we do not have the connectionID
            // Store connectionId : localMediaStream

        } catch (error) {
            console.error('Permission denied.');
        }
    }

    useEffect(() => {
        console.log("Local Media Stream State Changed...");
        if (localMediaStream !== null) {
            console.log("Adding ourselves...");
            setMediaStreams({
                ...mediaStreams,
                [window.location.pathname.split('/')[1]]: localMediaStream
            })
        }
    }, [localMediaStream]);

    // CurrentId is adding PeerId
    const handleAddClient = useCallback(async ({ currentSocketId, currentUserId, peerSocketId, peerUserId, offer }: { currentSocketId: string, currentUserId: string, peerSocketId: string, peerUserId: string, offer: boolean }) => {
        console.log(`ADD CLIENT => current: ${currentUserId} peer: ${peerUserId} offer: ${offer}`);
        console.log(peerConnections);

        // Grab the current connection
        // NOTE: The currentId will not be in the room on the first time this function is called
        let currentConnection = peerConnections[currentSocketId];
        if (currentConnection === undefined) {
            currentConnection = new RTCPeerConnection({
                iceServers: ICE_SERVERS
            });
            setPeerConnections({
                ...peerConnections,
                [currentSocketId]: currentConnection
            });
        }

        // Start sending ICE candidates to the peer...
        currentConnection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            socket.current!.emit("relay_ice", {
                currentSocketId,
                peerSocketId,
                iceCandidate: event.candidate,
            });
        };

        // Callback when the remote peer starts streaming...
        currentConnection.ontrack = ({ streams: [remoteStream] }) => {
            // TODO: Could be overwriting existing streams, not sure what's happening here...
            console.log(`On Track => current: ${currentUserId}`);
            console.log(remoteStream);
            setMediaStreams({
                ...mediaStreams,
                [peerUserId]: remoteStream
            });
        }

        // TODO: Are we adding the track to ourselves?
        localMediaStream!.getTracks().forEach(async (track) => {
            console.log(`ADD Local Media Track => current ${currentUserId}`);
            console.log(track);
            await currentConnection?.addTrack(track, localMediaStream!);
        });

        // Creating an offer and sending the offer to the other clients
        if (offer) {
            // Create an offer to send to the peer
            const sessionDescription = await currentConnection.createOffer({
                // offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });

            currentConnection.setLocalDescription(sessionDescription);

            // Notify the server about the SDP (Session Description Protocol) containing data bout the peer's device. https://www.tutorialspoint.com/webrtc/webrtc_session_description_protocol.htm
            // Peers need to exchange SDP before they can establish a connection.
            console.log(`RELAY_SDP current: ${currentUserId}, peer: ${peerUserId}`)
            socket.current!.emit("relay_sdp", {
                currentSocketId,
                peerSocketId,
                sessionDescription
            });
        }
    }, [peerConnections, mediaStreams]);

    // The current connection has received an SDP relayed by the server
    const handleSDP = useCallback(async ({ currentSocketId, peerSocketId, sessionDescription }: { currentSocketId: string, peerSocketId: string, sessionDescription: RTCSessionDescriptionInit }) => {
        console.log(`HANDLE SDP => to ${currentSocketId} from ${peerSocketId}`)
        console.log(sessionDescription);

        let currentConnection = peerConnections[currentSocketId];
        if (currentConnection === undefined) {
            currentConnection = new RTCPeerConnection({
                iceServers: ICE_SERVERS
            });
            setPeerConnections({
                ...peerConnections,
                [currentSocketId]: currentConnection
            })
        }

        await currentConnection?.setRemoteDescription(new RTCSessionDescription(sessionDescription));

        // If the incoming session description was an offer, create an answer
        if (sessionDescription.type == 'offer') {
            console.log(`ANSWERING SDP => ${currentSocketId} answering ${peerSocketId}`);
            const answerDescription = await currentConnection?.createAnswer();
            await currentConnection.setLocalDescription(answerDescription);
            console.log(answerDescription);

            // Notify the offering peer of the answer
            socket.current!.emit("relay_sdp", {
                currentSocketId,
                peerSocketId,
                sessionDescription: answerDescription
            })
        }
    }, [peerConnections, mediaStreams]);

    const handleIceCandidate = useCallback(async ({ currentSocketId, peerSocketId, iceCandidate }: { currentSocketId: string, peerSocketId: string, iceCandidate: RTCIceCandidate | null }) => {
        if (iceCandidate !== null) {
            console.log(`HandleIceCandidate => to ${currentSocketId} from ${peerSocketId}`);
            // console.log(iceCandidate);
            const currentConnection = peerConnections[currentSocketId]!;

            await currentConnection.addIceCandidate(iceCandidate);
        }
    }, [peerConnections, mediaStreams])

    // Handling an add client event from the server
    useEffect(() => {
        socket.current!.on("add_client", handleAddClient);
        return () => {
            socket.current!.off("add_client", handleAddClient);
        }
    }, [handleAddClient]);

    // Handling the SDP from the server
    useEffect(() => {
        socket.current!.on("session_description", handleSDP);
        return () => {
            socket.current!.off("session_description", handleSDP);
        };
    }, [handleSDP]);

    // Handling the ICE candidate from the server
    useEffect(() => {
        socket.current!.on("ice_candidate", handleIceCandidate);
        return () => {
            socket.current!.off("ice_candidate", handleIceCandidate);
        }
    }, [handleIceCandidate]);

    useEffect(() => {
        console.log("MEDIA STREAM CHANGED....");
        console.log(mediaStreams);
    }, [mediaStreams]);

    return <div>
        {
            // Loop through the tracks
            Object.entries(mediaStreams).map(
                ([userId, mediaStream]) => <div key={userId}>
                    <Video
                        srcObject={mediaStream}
                        height={500}
                        autoPlay
                    />
                </div>
            )
        }
    </div>
}

export default Room