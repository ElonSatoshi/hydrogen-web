 - relevant MSCs next to spec:
  - https://github.com/matrix-org/matrix-doc/pull/2746 Improved Signalling for 1:1 VoIP
  - https://github.com/matrix-org/matrix-doc/pull/2747 Transferring VoIP Calls
  - https://github.com/matrix-org/matrix-doc/pull/3077 Support for multi-stream VoIP
  - https://github.com/matrix-org/matrix-doc/pull/3086 Asserted identity on VoIP calls
  - https://github.com/matrix-org/matrix-doc/pull/3291 Muting in VoIP calls
  - https://github.com/matrix-org/matrix-doc/pull/3401 Native Group VoIP Signalling


## TODO
 - DONE: implement receiving hangup
 - making logging better
 - implement renegotiation
 - finish session id support
    - call peers are essentially identified by (userid, deviceid, sessionid). If see a new session id, we first disconnect from the current member so we're ready to connect with a clean slate again (in a member event, also in to_device? no harm I suppose, given olm encryption ensures you can't spoof the deviceid).
 - implement to_device messages arriving before m.call(.member) state event
 - implement muting tracks with m.call.sdp_stream_metadata_changed
 - DONE: implement cloning the localMedia so it works in safari?
 - DONE: implement 3 retries per peer
 - reeable crypto & implement fetching olm keys before sending encrypted signalling message
 - local echo for join/leave buttons?
 - make UI pretsy
    - figure out video layout
    - figure out nav structure
 - batch outgoing to_device messages in one request to homeserver for operations that will send out an event to all participants (e.g. mute)
 - don't load all members when loading calls to know whether they are ringing and joined by ourself
    - only load our own member once, then have a way to load additional members on a call.
 - see if we remove partyId entirely, it is only used for detecting remote echo which is not an issue for group calls? see https://github.com/matrix-org/matrix-spec-proposals/blob/dbkr/msc2746/proposals/2746-reliable-voip.md#add-party_id-to-all-voip-events
## TODO (old)
 - PeerCall
    - send invite
    - implement terminate
    - implement waitForState
    
        - find out if we need to do something different when renegotation is triggered (a subsequent onnegotiationneeded event) whether
          we sent the invite/offer or answer. e.g. do we always do createOffer/setLocalDescription and then send it over a matrix negotiation event? even if we before called createAnswer.
    - handle receiving offer and send anwser
    - handle sending ice candidates
        - handle ice candidates finished (iceGatheringState === 'complete')
    - handle receiving ice candidates
    - handle sending renegotiation
    - handle receiving renegotiation
    - reject call
    - hangup call
    - handle muting tracks
    - handle remote track being muted
    - handle adding/removing tracks to an ongoing call
    - handle sdp metadata
 - Participant
    - handle glare
    - encrypt to_device message with olm
    - batch outgoing to_device messages in one request to homeserver for operations that will send out an event to all participants (e.g. mute)
    - find out if we should start muted or not?

## Store ongoing calls

DONE: Add store with all ongoing calls so when we quit and start again, we don't have to go through all the past calls to know which ones might still be ongoing.


## Notes

we send m.call as state event in room

we add m.call.participant for our own device

we wait for other participants to add their user and device (in the sources)

for each (userid, deviceid)
    - if userId < ourUserId
        - get local media
        - we setup a peer connection
        - add local tracks
        - we wait for negotation event to get sdp
        - peerConn.createOffer
        - peerConn.setLocalDescription
        - we send an m.call.invite 
    - else
        - wait for invite from other side

on local ice candidate:
    - if we haven't ... sent invite yet? or received answer? buffer candidate
    - otherwise send candidate (without buffering?)

on incoming call:
    - ring, offer to answer

answering incoming call
    - get local media
    - peerConn.setRemoteDescription
    - add local tracks to peerConn
    - peerConn.createAnswer()
    - peerConn.setLocalDescription

in some cases, we will actually send the invite to all devices (e.g. SFU), so
we probably still need to handle multiple anwsers?

so we would send an invite to multiple devices and pick the one for which we
received the anwser first. between invite and anwser, we could already receive
ice candidates that we need to buffer.



updating the metadata:

if we're renegotiating: use m.call.negotatie
if just muting: use m.call.sdp_stream_metadata_changed


party identification
 - for 1:1 calls, we identify with a party_id
 - for group calls, we identify with a device_id




## TODO

Build basic version of PeerCall
    - add candidates code
DONE: Build basic version of GroupCall
    - DONE: add state, block invalid actions
DONE: Make it possible to olm encrypt the messages
Do work needed for state events
    - DONEish: receiving (almost done?)
    - DONEish: sending
logging
DONE: Expose call objects
    expose volume events from audiotrack to group call
DONE: Write view model
DONE: write view
 - handle glare edge-cases (not yet sent): https://spec.matrix.org/latest/client-server-api/#glare

## Calls questions
 - how do we handle glare between group calls (e.g. different state events with different call ids?)
 - Split up DOM part into platform code? What abstractions to choose?
   Does it make sense to come up with our own API very similar to DOM api?
 - what code do we copy over vs what do we implement ourselves?
    - MatrixCall: perhaps we can copy it over and modify it to our needs? Seems to have a lot of edge cases implemented.
        - what is partyId about?
    - CallFeed: I need better understand where it is used. It's basically a wrapper around a MediaStream with volume detection. Could it make sense to put this in platform for example?
 
 - which parts of MSC2746 are still relevant for group calls?
 - which parts of MSC2747 are still relevant for group calls? it seems mostly orthogonal?
 - SOLVED: how does switching channels work? This was only enabled by MSC 2746
    - you do getUserMedia()/getDisplayMedia() to get the stream(s)
    - you call removeTrack/addTrack on the peerConnection
    - you receive a negotiationneeded event
    - you call createOffer
    - you send m.call.negotiate
 - SOLVED: wrt to MSC2746, is the screen share track and the audio track (and video track) part of the same stream? or do screen share tracks need to go in a different stream? it sounds incompatible with the MSC2746 requirement.
 - SOLVED: how does muting work? MediaStreamTrack.enabled
 - SOLVED: so, what's the difference between the call_id and the conf_id in group call events?
    - call_id is the specific 1:1 call, conf_id is the thing in the m.call state event key
    - so a group call has a conf_id with MxN peer calls, each having their call_id.

I think we need to synchronize the negotiation needed because we don't use a CallState to guard it...

## Thursday 3-3 notes

we probably best keep the perfect negotiation flags, as they are needed for both starting the call AND renegotiation? if only for the former, it would make sense as it is a step in setting up the call, but if the call is ongoing, does it make sense to have a MakingOffer state? it actually looks like they are only needed for renegotiation! for call setup we compare the call_ids. What does that mean for these flags?


## Peer call state transitions

FROM CALLER                                         FROM CALLEE

Fledgling                                           Fledgling
 V `call()`                                          V `handleInvite()`: setRemoteDescription(event.offer), add buffered candidates
 V                                                  Ringing
 V                                                   V `answer()`
CreateOffer                                          V
 V add local tracks                                  V
 V wait for negotionneeded events                    V add local tracks
 V setLocalDescription()                            CreateAnswer
 V send invite event                                 V setLocalDescription(createAnswer())
InviteSent                                           |
 V receive anwser, setRemoteDescription()            |
 \___________________________________________________/
                             V
                            Connecting
                             V receive ice candidates and iceConnectionState becomes 'connected'
                            Connected
                             V `hangup()` or some terminate condition
                            Ended

so if we don't want to bother with having two call objects, we can make the existing call hangup his old call_id? That way we keep the old peerConnection.


when glare, won't we drop both calls? No: https://github.com/matrix-org/matrix-spec-proposals/pull/2746#discussion_r819388754