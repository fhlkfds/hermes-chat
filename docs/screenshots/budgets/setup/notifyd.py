"""A stand-in desktop notification service for the app's private D-Bus: owns org.freedesktop.Notifications, answers
as mako or dunst would, and writes each notification it is asked to show to a log, one JSON object per line.
    DBUS_SESSION_BUS_ADDRESS=<the run's bus> python3 notifyd.py <log>
`kill -USR1 <pid>` clicks the newest notification, as the owner would: it sends `ActionInvoked(id, "default")`.
"""
import json, sys, time
from gi.repository import Gio, GLib

XML = """<node><interface name="org.freedesktop.Notifications">
<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/>
<arg type="i" direction="in"/><arg type="u" direction="out"/></method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
</interface></node>"""
LOG = sys.argv[1]
count = [0]

def call(conn, sender, path, iface, method, params, inv):
    if method == "Notify":
        app, _replaces, _icon, summary, body, actions, _hints, _timeout = params.unpack()
        count[0] += 1
        with open(LOG, "a") as f:
            f.write(json.dumps({"at": time.strftime("%H:%M:%S"), "app": app, "summary": summary, "body": body, "actions": actions}) + "\n")
        inv.return_value(GLib.Variant("(u)", (count[0],)))
    elif method == "GetCapabilities":
        inv.return_value(GLib.Variant("(as)", (["actions", "body"],)))
    elif method == "GetServerInformation":
        inv.return_value(GLib.Variant("(ssss)", ("notifyd-stand-in", "hermes-chat", "1", "1.2")))
    else:
        inv.return_value(None)

node = Gio.DBusNodeInfo.new_for_xml(XML)
bus = Gio.DBusConnection.new_for_address_sync(GLib.getenv("DBUS_SESSION_BUS_ADDRESS"), Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
bus.register_object("/org/freedesktop/Notifications", node.interfaces[0], call, None, None)
Gio.bus_own_name_on_connection(bus, "org.freedesktop.Notifications", Gio.BusNameOwnerFlags.NONE, None, None)
def click():
    if count[0]:
        bus.emit_signal(None, "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "ActionInvoked", GLib.Variant("(us)", (count[0], "default")))
        with open(LOG, "a") as f:
            f.write(json.dumps({"at": time.strftime("%H:%M:%S"), "clicked": count[0]}) + "\n")
    return GLib.SOURCE_CONTINUE

GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 10, click)  # SIGUSR1
GLib.MainLoop().run()
