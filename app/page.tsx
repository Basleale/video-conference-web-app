"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export default function VideoConferenceRoom() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  // Initialize the fucking camera and microphone on load
  useEffect(() => {
    const startMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: true, 
          audio: true 
        });
        setLocalStream(stream);
        
        // This right here is why your video was probably blank. 
        // You MUST attach the stream to the video element's srcObject.
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (error) {
        console.error("Failed to get media devices. Check your browser permissions:", error);
      }
    };
    
    startMedia();

    // Cleanup tracks when the component unmounts so the camera light turns off
    return () => {
      localStream?.getTracks().forEach(track => track.stop());
    };
  }, []);

  const toggleAudio = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOff(!videoTrack.enabled);
      }
    }
  };

  const toggleScreenShare = async () => {
    try {
      if (!isScreenSharing) {
        // Request screen stream from the user
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        // Swap the video element to show the screen share
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = screenStream;
        }
        setIsScreenSharing(true);

        // Listen for the native "Stop Sharing" browser button
        screenTrack.onended = () => {
          if (localVideoRef.current && localStream) {
            localVideoRef.current.srcObject = localStream; // Revert back to camera
          }
          setIsScreenSharing(false);
        };
      } else {
        // Manually toggle off screen share
        const currentStream = localVideoRef.current?.srcObject as MediaStream;
        currentStream?.getTracks().forEach(track => track.stop());
        
        if (localVideoRef.current && localStream) {
          localVideoRef.current.srcObject = localStream;
        }
        setIsScreenSharing(false);
      }
    } catch (error) {
      console.error("Screen sharing failed to launch:", error);
    }
  };

  return (
    <div className="flex flex-col items-center p-6 min-h-screen bg-slate-950 text-white">
      <h1 className="text-3xl font-bold mb-8">Live Room</h1>

      <div className="relative w-full max-w-4xl aspect-video bg-black rounded-xl overflow-hidden border-2 border-slate-800 shadow-2xl">
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted // ALWAYS mute local video to prevent brutal audio feedback loops
          className={`w-full h-full object-cover ${isVideoOff && !isScreenSharing ? 'hidden' : 'block'}`}
        />
        {isVideoOff && !isScreenSharing && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900">
            <span className="text-slate-500 font-medium">Camera is off</span>
          </div>
        )}
      </div>

      <div className="flex gap-4 mt-8">
        <Button 
          onClick={toggleAudio} 
          variant={isAudioMuted ? "destructive" : "default"}
          className="w-32"
        >
          {isAudioMuted ? "Unmute" : "Mute"}
        </Button>
        <Button 
          onClick={toggleVideo} 
          variant={isVideoOff ? "destructive" : "default"}
          className="w-40"
        >
          {isVideoOff ? "Start Video" : "Stop Video"}
        </Button>
        <Button 
          onClick={toggleScreenShare} 
          variant={isScreenSharing ? "destructive" : "default"}
          className="w-40"
        >
          {isScreenSharing ? "Stop Sharing" : "Share Screen"}
        </Button>
      </div>
    </div>
  );
}