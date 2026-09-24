'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Mic, MicOff, Video, VideoOff, MonitorUp, MessageSquare, Users, PhoneOff, Copy, Send, Settings, MoreHorizontal, ShieldCheck, Link2, Sparkles } from 'lucide-react'

type Message = { id: string; sender_name: string; body: string; created_at: string }
type Participant = { id: string; peerId: string; name: string; initials: string; color: string; muted?: boolean; self?: boolean }
type Signal = { from: string; to?: string; kind: 'offer' | 'answer' | 'ice'; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }

const colors = ['#8b7cf6', '#ec8b6f', '#63c7b2', '#dfb85a']
const makeCode = () => Math.random().toString(36).slice(2, 8).toUpperCase()

export default function Page() {
  const supabase = createClient()
  const [roomCode, setRoomCode] = useState('')
  const [roomId, setRoomId] = useState<string | null>(null)
  const [name, setName] = useState('You')
  const [joined, setJoined] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [videoOn, setVideoOn] = useState(true)
  const [shareOn, setShareOn] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const peersRef = useRef(new Map<string, RTCPeerConnection>())
  const peerIdRef = useRef(crypto.randomUUID())
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [elapsed, setElapsed] = useState(0)

  const startMedia = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
    } catch {
      setVideoOn(false)
      setMicOn(false)
      setError('Camera and microphone access is unavailable. You can still join with them off.')
    }
  }, [])

  const createRoom = async () => {
    setLoading(true); setError('')
    const code = makeCode()
    const { data, error: dbError } = await supabase.from('conference_rooms').insert({ room_code: code, host_name: name || 'Host', title: 'Team sync' }).select('id, room_code').single()
    setLoading(false)
    if (dbError) { setError('Could not create the room. Please try again.'); return }
    await startMedia(); setRoomCode(data.room_code); setRoomId(data.id); setJoined(true)
  }

  const joinRoom = async () => {
    if (!roomCode.trim()) return
    setLoading(true); setError('')
    const { data, error: dbError } = await supabase.from('conference_rooms').select('id, room_code, ended_at').eq('room_code', roomCode.trim().toUpperCase()).maybeSingle()
    setLoading(false)
    if (dbError || !data || data.ended_at) { setError('That room does not exist or has ended.'); return }
    await startMedia(); setRoomCode(data.room_code); setRoomId(data.id); setJoined(true)
  }

  useEffect(() => {
    if (!roomId || !streamRef.current) return
    let active = true
    const peers = peersRef.current
    const send = (signal: Signal) => channelRef.current?.send({ type: 'broadcast', event: 'signal', payload: signal })
    const makePeer = (remotePeerId: string) => {
      const existing = peers.get(remotePeerId)
      if (existing) return existing
      const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      streamRef.current?.getTracks().forEach(track => peer.addTrack(track, streamRef.current!))
      peer.onicecandidate = event => { if (event.candidate) send({ from: peerIdRef.current, to: remotePeerId, kind: 'ice', candidate: event.candidate.toJSON() }) }
      peer.ontrack = event => setRemoteStreams(current => ({ ...current, [remotePeerId]: event.streams[0] }))
      peer.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) { peer.close(); peers.delete(remotePeerId); setRemoteStreams(current => { const next = { ...current }; delete next[remotePeerId]; return next }) } }
      peers.set(remotePeerId, peer)
      return peer
    }
    const connectTo = async (remotePeerId: string) => {
      const peer = makePeer(remotePeerId)
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      send({ from: peerIdRef.current, to: remotePeerId, kind: 'offer', description: offer })
    }
    const setup = async () => {
      const { data } = await supabase.from('conference_messages').select('id, sender_name, body, created_at').eq('room_id', roomId).order('created_at', { ascending: true }).limit(100)
      if (active && data) setMessages(data)
      const channel = supabase.channel(`room:${roomId}`, { config: { presence: { key: peerIdRef.current } } })
      channelRef.current = channel
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conference_messages', filter: `room_id=eq.${roomId}` }, payload => setMessages(current => current.some(m => m.id === payload.new.id) ? current : [...current, payload.new as Message]))
        .on('broadcast', { event: 'signal' }, async ({ payload }: { payload: Signal }) => {
          if (payload.to && payload.to !== peerIdRef.current) return
          const peer = makePeer(payload.from)
          if (payload.kind === 'offer' && payload.description) {
            await peer.setRemoteDescription(payload.description)
            const answer = await peer.createAnswer(); await peer.setLocalDescription(answer)
            send({ from: peerIdRef.current, to: payload.from, kind: 'answer', description: answer })
          } else if (payload.kind === 'answer' && payload.description && peer.signalingState === 'have-local-offer') {
            await peer.setRemoteDescription(payload.description)
          } else if (payload.kind === 'ice' && payload.candidate) {
            await peer.addIceCandidate(payload.candidate)
          }
        })
        .on('presence', { event: 'sync' }, () => {
          const state = channel.presenceState<{ name: string; peerId: string }>()
          const entries = Object.values(state).flat()
          const people = entries.map((p, index) => ({ id: p.peerId, peerId: p.peerId, name: p.name, initials: p.name.slice(0, 2).toUpperCase(), color: colors[index % colors.length], self: p.peerId === peerIdRef.current }))
          setParticipants(people)
          entries.filter(p => p.peerId !== peerIdRef.current && peerIdRef.current < p.peerId).forEach(p => void connectTo(p.peerId))
        })
        .subscribe(async status => { if (status === 'SUBSCRIBED') await channel.track({ name: name || 'You', peerId: peerIdRef.current }) })
    }
    setup()
    const timer = window.setInterval(() => setElapsed(v => v + 1), 1000)
    return () => { active = false; window.clearInterval(timer); peers.forEach(peer => peer.close()); peers.clear(); setRemoteStreams({}); if (channelRef.current) supabase.removeChannel(channelRef.current); streamRef.current?.getTracks().forEach(track => track.stop()) }
  }, [roomId, name, supabase])

  const toggleMic = () => { const next = !micOn; setMicOn(next); streamRef.current?.getAudioTracks().forEach(t => t.enabled = next) }
  const toggleVideo = () => { const next = !videoOn; setVideoOn(next); streamRef.current?.getVideoTracks().forEach(t => t.enabled = next) }
  const sendMessage = async () => {
    const body = message.trim(); if (!body || !roomId) return
    setMessage('')
    await supabase.from('conference_messages').insert({ room_id: roomId, sender_name: name || 'You', body })
  }
  const copyInvite = async () => { await navigator.clipboard?.writeText(`${window.location.origin}?room=${roomCode}`); setCopied(true); window.setTimeout(() => setCopied(false), 1800) }
  const leave = async () => { if (roomId) await supabase.from('conference_rooms').update({ ended_at: new Date().toISOString() }).eq('id', roomId); streamRef.current?.getTracks().forEach(t => t.stop()); setJoined(false); setRoomId(null); setMessages([]); setElapsed(0) }
  const time = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`

  if (!joined) return <Landing name={name} setName={setName} roomCode={roomCode} setRoomCode={setRoomCode} createRoom={createRoom} joinRoom={joinRoom} loading={loading} error={error} />
  return <main className="conference-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Sparkles size={15} /></span><span>Bezelx Chat</span></div><div className="room-meta"><span className="live-dot" /> <span>Live</span><span className="room-divider" /> <span>{time}</span><span className="room-code">{roomCode}</span></div><div className="top-actions"><button className="icon-button" aria-label="Settings"><Settings size={18} /></button><button className="avatar">{(name || 'Y').slice(0, 1).toUpperCase()}</button></div></header>
    <section className="meeting-layout"><div className="stage-wrap"><div className="stage-header"><div><p className="eyebrow">TEAM SYNC</p><h1>Weekly product review</h1></div><button className="invite-button" onClick={copyInvite}><Link2 size={15} /> {copied ? 'Copied' : 'Invite people'} </button></div><div className="video-grid"><div className="video-tile video-self">{videoOn ? <video ref={videoRef} autoPlay muted playsInline /> : <div className="video-placeholder" style={{ background: 'linear-gradient(135deg, #35344c, #1d1d2a)' }}><strong>{(name || 'Y').slice(0, 1).toUpperCase()}</strong></div>}<div className="tile-label"><span className="tile-speaking" />{name || 'You'} <span className="you-label">(You)</span>{!micOn && <MicOff size={13} />}</div><span className="quality"><ShieldCheck size={12} /> Good</span></div>{participants.filter(p => !p.self).map(person => <div className="video-tile" key={person.id}>{remoteStreams[person.peerId] ? <RemoteVideo stream={remoteStreams[person.peerId]} /> : <div className="video-placeholder" style={{ background: `linear-gradient(135deg, ${person.color}66, #15151f)` }}><strong>{person.initials}</strong><span className="person-name">{person.name}</span></div>}<div className="tile-label">{person.name} {person.muted && <MicOff size={13} />}</div></div>)}{participants.filter(p => !p.self).length === 0 && <div className="video-tile waiting-tile"><Users size={24} /><p>Share the invite to bring people in</p><button onClick={copyInvite}>{copied ? 'Invite copied' : 'Copy invite link'}</button></div>}</div><div className="control-bar"><div className="control-group"><button className={`control-button ${!micOn ? 'off' : ''}`} onClick={toggleMic}>{micOn ? <Mic size={19} /> : <MicOff size={19} />}</button><button className={`control-button ${!videoOn ? 'off' : ''}`} onClick={toggleVideo}>{videoOn ? <Video size={19} /> : <VideoOff size={19} />}</button><button className={`control-button ${shareOn ? 'active' : ''}`} onClick={() => setShareOn(v => !v)}><MonitorUp size={19} /></button><button className={`control-button ${chatOpen ? 'active' : ''}`} onClick={() => setChatOpen(v => !v)}><MessageSquare size={19} /><span className="count-badge">{messages.length}</span></button><button className="control-button"><MoreHorizontal size={19} /></button></div><button className="leave-button" onClick={leave}><PhoneOff size={18} /> Leave</button></div></div>{chatOpen && <aside className="chat-panel"><div className="chat-head"><div><h2>In-call chat</h2><p>{participants.length || 1} participant{participants.length === 1 ? '' : 's'}</p></div><button className="icon-button" onClick={() => setChatOpen(false)}><span className="close-x">×</span></button></div><div className="messages">{messages.length === 0 ? <div className="empty-chat"><MessageSquare size={22} /><p>No messages yet</p><span>Start the conversation with your team.</span></div> : messages.map(m => <div className={`message ${m.sender_name === name ? 'mine' : ''}`} key={m.id}><div className="message-avatar">{m.sender_name.slice(0, 1).toUpperCase()}</div><div><div className="message-info"><strong>{m.sender_name}</strong><time>{new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p>{m.body}</p></div></div>)}</div><div className="chat-compose"><input value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) sendMessage() }} placeholder="Message everyone..." aria-label="Message everyone" /><button onClick={sendMessage} aria-label="Send message"><Send size={16} /></button></div></aside>}</section>
  </main>
}

function RemoteVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  return <video ref={ref} autoPlay playsInline />
}

function Landing({ name, setName, roomCode, setRoomCode, createRoom, joinRoom, loading, error }: { name: string; setName: (v: string) => void; roomCode: string; setRoomCode: (v: string) => void; createRoom: () => void; joinRoom: () => void; loading: boolean; error: string }) {
  return <main className="landing"><div className="landing-nav"><div className="brand"><span className="brand-mark"><Sparkles size={15} /></span><span>Bezelx Chat</span></div><span className="secure-note"><ShieldCheck size={15} /> End-to-end encrypted</span></div><div className="hero"><div className="hero-copy"><p className="eyebrow">VIDEO MEETINGS, REIMAGINED</p><h1>Make space for <em>better</em> conversations.</h1><p className="hero-sub">A calm, focused place for your team to connect, collaborate, and move ideas forward.</p><div className="trust-row"><span><span className="trust-dot" /> No downloads</span><span><span className="trust-dot" /> Free to start</span><span><span className="trust-dot" /> Built for teams</span></div></div><div className="join-card"><div className="card-accent" /><h2>Start a meeting</h2><p>Create a room or join one already in progress.</p><label>Your name<input value={name} onChange={e => setName(e.target.value)} placeholder="How should we call you?" /></label><button className="primary-cta" onClick={createRoom} disabled={loading || !name.trim()}>{loading ? 'Creating room...' : 'Create new room'} <span>↗</span></button><div className="or"><span />or<span /></div><div className="code-row"><input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} placeholder="Enter room code" maxLength={6} /><button onClick={joinRoom} disabled={loading || roomCode.length < 4}>Join room</button></div>{error && <p className="error-message">{error}</p>}<p className="terms">By continuing, you agree to our <u>terms</u> and <u>privacy policy</u>.</p></div></div><footer><span>© 2026 Bezelx Chat conferencing</span><span>Simple tools for meaningful work.</span></footer></main>
}
