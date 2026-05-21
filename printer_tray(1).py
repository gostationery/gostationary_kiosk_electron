import gi
gi.require_version('Gtk', '3.0')
gi.require_version('AppIndicator3', '0.1')
gi.require_version('Notify', '0.7')
from gi.repository import Gtk, AppIndicator3, Notify, GLib
import usb.core
import usb.util
import cups
import time

VENDOR_ID  = 0x0fe6
PRODUCT_ID = 0x811e

CMD_OFFLINE_STATUS = bytes([0x10, 0x04, 0x02])
CMD_PAPER_STATUS   = bytes([0x10, 0x04, 0x04])

prev_state = {}
prev_jobs  = {}

Notify.init("Printer Monitor")

indicator = AppIndicator3.Indicator.new(
    "printer-monitor",
    "printer",
    AppIndicator3.IndicatorCategory.HARDWARE
)
indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)

menu         = Gtk.Menu()
item_online  = Gtk.MenuItem(label="Printer: Checking...")
item_door    = Gtk.MenuItem(label="Door: --")
item_paper   = Gtk.MenuItem(label="Paper: --")
item_low     = Gtk.MenuItem(label="Low Paper: --")
item_error   = Gtk.MenuItem(label="Error: --")
item_sep1    = Gtk.SeparatorMenuItem()
item_job     = Gtk.MenuItem(label="Last Job: --")
item_jobstat = Gtk.MenuItem(label="Job Status: --")
item_sep2    = Gtk.SeparatorMenuItem()
item_quit    = Gtk.MenuItem(label="Quit")

item_quit.connect("activate", Gtk.main_quit)

for item in [item_online, item_door, item_paper, item_low, item_error,
             item_sep1, item_job, item_jobstat, item_sep2, item_quit]:
    menu.append(item)

menu.show_all()
indicator.set_menu(menu)

def send_notification(title, message, urgent=False):
    try:
        n = Notify.Notification.new(title, message, "printer")
        if urgent:
            n.set_urgency(Notify.Urgency.CRITICAL)
        n.show()
    except Exception:
        pass

def check_jobs():
    global prev_jobs
    try:
        conn = cups.Connection()
        # Fix: use simple getJobs() call without problematic parameters
        jobs = conn.getJobs(which_jobs='all', my_jobs=False)

        for job_id, job in jobs.items():
            job_state = job.get('job-state', 0)
            job_name  = job.get('job-name', 'Unknown')
            prev      = prev_jobs.get(job_id, {})
            prev_st   = prev.get('job-state', 0)

            # state 5 = printing
            if job_state == 5 and prev_st != 5:
                send_notification("Printer: Job Started", "Printing: " + job_name)
                GLib.idle_add(item_job.set_label,     "Last Job: " + job_name[:30])
                GLib.idle_add(item_jobstat.set_label, "Job Status: PRINTING...")

            # state 9 = completed
            elif job_state == 9 and prev_st != 9:
                send_notification("Printer: Job Completed", "Done: " + job_name)
                GLib.idle_add(item_job.set_label,     "Last Job: " + job_name[:30])
                GLib.idle_add(item_jobstat.set_label, "Job Status: Completed")

            # state 7 = cancelled
            elif job_state == 7 and prev_st != 7:
                send_notification("Printer: Job Cancelled",
                                  "Cancelled: " + job_name, urgent=True)
                GLib.idle_add(item_jobstat.set_label, "Job Status: Cancelled")

            # state 8 = aborted/failed
            elif job_state == 8 and prev_st != 8:
                send_notification("Printer: Job Failed",
                                  "Failed: " + job_name, urgent=True)
                GLib.idle_add(item_jobstat.set_label, "Job Status: FAILED")

        prev_jobs = {jid: dict(jdata) for jid, jdata in jobs.items()}

    except Exception as e:
        GLib.idle_add(item_jobstat.set_label, "Job: " + str(e)[:25])

def get_status():
    global prev_state

    check_jobs()

    dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
    if dev is None:
        GLib.idle_add(item_online.set_label, "Printer: NOT FOUND")
        indicator.set_icon_full("dialog-error", "Printer Not Found")
        return True

    try:
        if dev.is_kernel_driver_active(0):
            dev.detach_kernel_driver(0)

        dev.set_configuration()
        cfg  = dev.get_active_configuration()
        intf = cfg[(0, 0)]

        ep_out = usb.util.find_descriptor(intf, custom_match=lambda e:
            usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT)
        ep_in  = usb.util.find_descriptor(intf, custom_match=lambda e:
            usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN)

        ep_out.write(CMD_OFFLINE_STATUS)
        time.sleep(0.2)
        s2 = ep_in.read(1, timeout=3000)[0]

        ep_out.write(CMD_PAPER_STATUS)
        time.sleep(0.2)
        s4 = ep_in.read(1, timeout=3000)[0]

        state = {
            'door_open' : bool(s2 & 0x04),
            'paper_end' : bool(s2 & 0x20) or bool(s4 & 0x20),
            'paper_low' : bool(s4 & 0x04),
            'error'     : bool(s2 & 0x40),
        }
        online = (s2 == 0x12)

        if state != prev_state:
            if state['door_open'] and not prev_state.get('door_open'):
                send_notification("PRINTER ALERT", "Door is OPEN!", urgent=True)
            if not state['door_open'] and prev_state.get('door_open'):
                send_notification("Printer OK", "Door is now closed.")
            if state['paper_end'] and not prev_state.get('paper_end'):
                send_notification("PRINTER ALERT", "Paper is EMPTY!", urgent=True)
            if not state['paper_end'] and prev_state.get('paper_end'):
                send_notification("Printer OK", "Paper loaded successfully.")
            if state['paper_low'] and not prev_state.get('paper_low'):
                send_notification("PRINTER WARNING", "Paper is running LOW!", urgent=True)
            prev_state = state.copy()

        if state['paper_end'] or state['door_open'] or state['error']:
            indicator.set_icon_full("dialog-warning", "Printer Needs Attention")
        elif state['paper_low']:
            indicator.set_icon_full("dialog-information", "Paper Low")
        else:
            indicator.set_icon_full("printer", "Printer OK")

        GLib.idle_add(item_online.set_label,
            "Printer Online:  YES" if online else "Printer Online:  NO")
        GLib.idle_add(item_door.set_label,
            "Door:   OPEN" if state['door_open'] else "Door:   Closed")
        GLib.idle_add(item_paper.set_label,
            "Paper:  EMPTY" if state['paper_end'] else "Paper:  OK")
        GLib.idle_add(item_low.set_label,
            "Low Paper:  WARNING" if state['paper_low'] else "Low Paper:  OK")
        GLib.idle_add(item_error.set_label,
            "Error:  YES" if state['error'] else "Error:  None")

    except Exception as e:
        GLib.idle_add(item_online.set_label, "Printer: Error - " + str(e)[:25])
    finally:
        try:
            usb.util.dispose_resources(dev)
            dev.attach_kernel_driver(0)
        except:
            pass
    return True

GLib.timeout_add_seconds(3, get_status)
get_status()

Gtk.main()
