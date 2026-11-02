# Two panes share chat identity and track only visible chats as read

Two panes are views over the same Hermes connection and profile, not separate connections. The chat list and Search
open in the focused pane. Switching profile closes the second pane before switching; drafts remain scoped by
connection/profile/chat as before. Layout is transient; the focused chat remains the one saved for reopen-on-launch.

The same chat may be shown twice. Both views share one draft, transcript, outbox, runtime session, stream and Approval
state. Existing transport guards prevent duplicate submission and Approval answers. Scroll, Find and unsent
attachments are per-view. Closing a view never stops a reply. The New chat draft is shared too, as in the existing
per-profile draft model; sending clears it in both views.

The transport tracks visible chats by pane key. Leaving one view does not remove another view's read tracking. When
the window regains focus, each still-visible chat with pending activity is marked read. Narrow windows keep the hidden
view mounted but remove its read tracking and native-drop eligibility. Settings covers mounted panes similarly.
This extends ADR 0002's read behavior to two visible chats.

The divider keeps at least 320 pixels per chat, switching to one visible pane below 646 available pixels. Width
changes stay local to the layout component. A live drag step exceeding 50 ms switches the rest of that drag to a guide
line and applies the final width on release. Long transcripts still render their full DOM; this change adds no
virtualization. Benchmarks measure opening, two simultaneous streams, keyboard resizing and real mouse dragging.

The existing Preview Pane stays shared by the window. Either chat can open a link or file in it. Space taken by the
preview may trigger the chat-pane switcher; a preview overlay covers both chats and suspends their read tracking.
