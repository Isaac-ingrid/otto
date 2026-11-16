------------------------- MODULE EventDelivery -------------------------
EXTENDS Naturals, FiniteSets, TLC

(* One worker, a finite stream. "failure" is the explicit broken notice, not
   a successful report. Atomic Quarantine abstracts one SQLite transaction.
   Fault is ONLY for negative controls, never a production policy switch. *)
CONSTANTS MaxEvents, MaxCrashes, Fault
ASSUME /\ MaxEvents \in Nat \ {0}
       /\ MaxCrashes \in Nat
       /\ Fault \in {"none", "ack-before-persist", "poison"}
Events == 1..MaxEvents
Kinds == {"normal", "oversized", "failure"}
VARIABLES produced, pending, archive, wire, received, serverAck, clientAck,
          ackWire, processed, effects, online, crashes
vars == <<produced, pending, archive, wire, received, serverAck, clientAck,
          ackWire, processed, effects, online, crashes>>

Init == /\ produced = 0
        /\ pending = [i \in Events |-> "absent"]
        /\ archive = {}
        /\ wire = {}
        /\ received = [i \in Events |-> "none"]
        /\ serverAck = 0 /\ clientAck = 0 /\ ackWire = {}
        /\ processed = 0 /\ effects = [i \in Events |-> 0]
        /\ online = TRUE /\ crashes = 0

Produce == /\ produced < MaxEvents
           /\ \E kind \in {"normal", "oversized"}:
                pending' = [pending EXCEPT ![produced + 1] = kind]
           /\ produced' = produced + 1
           /\ UNCHANGED <<archive, wire, received, serverAck, clientAck,
                          ackWire, processed, effects, online, crashes>>

Quarantine(i) == /\ Fault # "poison" /\ online
                 /\ pending[i] = "oversized"
                 /\ archive' = archive \cup {i}
                 /\ pending' = [pending EXCEPT ![i] = "failure"]
                 /\ UNCHANGED <<produced, wire, received, serverAck, clientAck,
                                ackWire, processed, effects, online, crashes>>

Send(i) == /\ online
           /\ pending[i] \in IF Fault = "poison" THEN Kinds
                              ELSE {"normal", "failure"}
           /\ [seq |-> i, kind |-> pending[i]] \notin wire
           /\ wire' = wire \cup {[seq |-> i, kind |-> pending[i]]}
           /\ UNCHANGED <<produced, pending, archive, received, serverAck,
                          clientAck, ackWire, processed, effects, online, crashes>>

(* Receives may be reordered and replayed. Persistence precedes the ack.
   Real WebSocket order is stronger; this deliberately permits extra schedules. *)
Receive(i) == /\ online
              /\ \E msg \in wire:
                   /\ msg.seq = i /\ msg.kind # "oversized"
                   /\ received' = IF received[i] = "none"
                                     THEN [received EXCEPT ![i] = msg.kind]
                                     ELSE received
                   /\ wire' = wire \ {msg}
              /\ UNCHANGED <<produced, pending, archive, serverAck, clientAck,
                             ackWire, processed, effects, online, crashes>>

Contiguous == CHOOSE n \in 0..MaxEvents:
                /\ \A i \in 1..n: received[i] # "none"
                /\ IF n < MaxEvents THEN received[n + 1] = "none" ELSE TRUE
AdvanceAck == /\ serverAck < Contiguous
              /\ serverAck' = Contiguous
              /\ UNCHANGED <<produced, pending, archive, wire, received, clientAck,
                             ackWire, processed, effects, online, crashes>>
SendAck == /\ online /\ serverAck > clientAck /\ serverAck \notin ackWire
           /\ ackWire' = ackWire \cup {serverAck}
           /\ UNCHANGED <<produced, pending, archive, wire, received, serverAck,
                          clientAck, processed, effects, online, crashes>>
TakeAck == /\ online /\ ackWire # {}
           /\ \E n \in ackWire:
                /\ clientAck' = IF n > clientAck THEN n ELSE clientAck
                /\ pending' = [i \in Events |-> IF i <= clientAck'
                                                 THEN "acked" ELSE pending[i]]
                /\ ackWire' = ackWire \ {n}
           /\ UNCHANGED <<produced, archive, wire, received, serverAck,
                          processed, effects, online, crashes>>
Process == /\ processed < serverAck
           /\ processed' = processed + 1
           /\ effects' = [effects EXCEPT ![processed + 1] = @ + 1]
           /\ UNCHANGED <<produced, pending, archive, wire, received, serverAck,
                          clientAck, ackWire, online, crashes>>

(* A finite number of crashes/disconnections lose volatile messages, never
   acknowledged durable state. This does NOT model disk loss or log eviction. *)
Crash == /\ online /\ crashes < MaxCrashes
         /\ online' = FALSE /\ crashes' = crashes + 1
         /\ wire' = {} /\ ackWire' = {}
         /\ UNCHANGED <<produced, pending, archive, received, serverAck,
                        clientAck, processed, effects>>
Reconnect == /\ ~online /\ online' = TRUE
             /\ UNCHANGED <<produced, pending, archive, wire, received, serverAck,
                            clientAck, ackWire, processed, effects, crashes>>

(* Mutations retain the normal recovery rules. Their configurations must FAIL. *)
PrematureAck == /\ Fault = "ack-before-persist" /\ online
                /\ \E msg \in wire: /\ msg.seq > serverAck
                                    /\ serverAck' = msg.seq
                /\ UNCHANGED <<produced, pending, archive, wire, received,
                               clientAck, ackWire, processed, effects, online, crashes>>
RejectOversized == /\ Fault = "poison" /\ online
                  /\ \E msg \in wire: msg.kind = "oversized"
                  /\ online' = FALSE /\ wire' = {} /\ ackWire' = {}
                  /\ UNCHANGED <<produced, pending, archive, received, serverAck,
                                 clientAck, processed, effects, crashes>>
Next == \/ Produce \/ AdvanceAck \/ SendAck \/ TakeAck \/ Process
        \/ Crash \/ Reconnect \/ PrematureAck \/ RejectOversized
        \/ \E i \in Events: Quarantine(i) \/ Send(i) \/ Receive(i)

Spec == Init /\ [][Next]_vars
        /\ WF_vars(Produce) /\ WF_vars(AdvanceAck) /\ WF_vars(SendAck)
        /\ WF_vars(TakeAck) /\ WF_vars(Process) /\ WF_vars(Reconnect)
        /\ WF_vars(RejectOversized)
        /\ \A i \in Events: /\ WF_vars(Quarantine(i))
                              /\ WF_vars(Send(i)) /\ WF_vars(Receive(i))

TypeOK == /\ produced \in 0..MaxEvents
          /\ pending \in [Events -> Kinds \cup {"absent", "acked"}]
          /\ archive \subseteq Events
          /\ wire \subseteq [seq: Events, kind: Kinds]
          /\ received \in [Events -> {"none", "normal", "failure"}]
          /\ serverAck \in 0..MaxEvents /\ clientAck \in 0..MaxEvents
          /\ ackWire \subseteq 0..MaxEvents /\ processed \in 0..MaxEvents
          /\ effects \in [Events -> 0..MaxEvents]
          /\ online \in BOOLEAN /\ crashes \in 0..MaxCrashes
AckAfterPersist == \A i \in 1..serverAck: received[i] # "none"
NoForgottenUnacked == /\ clientAck <= serverAck
                      /\ \A i \in 1..produced:
                           (pending[i] = "acked") <=> (i <= clientAck)
ArchiveBeforeFailure == \A i \in Events:
                          (pending[i] = "failure" \/ received[i] = "failure") => i \in archive
NoFalseSuccess == \A i \in archive: received[i] # "normal"
AtMostOnce == /\ processed <= serverAck
              /\ \A i \in Events: effects[i] = IF i <= processed THEN 1 ELSE 0
AllResolved == <>(clientAck = MaxEvents /\ processed = MaxEvents)
=============================================================================
