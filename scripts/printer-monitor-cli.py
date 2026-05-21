#!/usr/bin/env python3
"""Headless printer snapshot for GoStationary Kiosk (JSON on stdout)."""
import json
import sys
import time

VENDOR_ID = 0x0FE6
PRODUCT_ID = 0x811E

CMD_OFFLINE_STATUS = bytes([0x10, 0x04, 0x02])
CMD_PAPER_STATUS = bytes([0x10, 0x04, 0x04])

JOB_STATE_LABELS = {
    3: "pending",
    4: "held",
    5: "printing",
    6: "stopped",
    7: "cancelled",
    8: "failed",
    9: "completed",
}


def fetch_cups_jobs():
    import cups

    conn = cups.Connection()
    jobs = conn.getJobs(which_jobs="all", my_jobs=False)
    out = []
    for job_id, job in jobs.items():
        state = int(job.get("job-state", 0))
        out.append(
            {
                "id": str(job_id),
                "name": str(job.get("job-name", "Unknown"))[:120],
                "state": state,
                "stateLabel": JOB_STATE_LABELS.get(state, "unknown"),
            }
        )
    return out


def fetch_usb_hardware():
    import usb.core
    import usb.util

    dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
    if dev is None:
        return {"found": False, "online": False, "error": "Printer USB device not found"}

    detached = False
    try:
        if dev.is_kernel_driver_active(0):
            dev.detach_kernel_driver(0)
            detached = True

        dev.set_configuration()
        cfg = dev.get_active_configuration()
        intf = cfg[(0, 0)]

        ep_out = usb.util.find_descriptor(
            intf,
            custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress)
            == usb.util.ENDPOINT_OUT,
        )
        ep_in = usb.util.find_descriptor(
            intf,
            custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress)
            == usb.util.ENDPOINT_IN,
        )

        ep_out.write(CMD_OFFLINE_STATUS)
        time.sleep(0.2)
        s2 = ep_in.read(1, timeout=3000)[0]

        ep_out.write(CMD_PAPER_STATUS)
        time.sleep(0.2)
        s4 = ep_in.read(1, timeout=3000)[0]

        state = {
            "doorOpen": bool(s2 & 0x04),
            "paperEnd": bool(s2 & 0x20) or bool(s4 & 0x20),
            "paperLow": bool(s4 & 0x04),
            "error": bool(s2 & 0x40),
        }
        online = s2 == 0x12

        return {
            "found": True,
            "online": online,
            "doorOpen": state["doorOpen"],
            "paperEnd": state["paperEnd"],
            "paperLow": state["paperLow"],
            "hardwareError": state["error"],
        }
    except Exception as exc:
        return {"found": True, "online": False, "error": str(exc)[:200]}
    finally:
        try:
            usb.util.dispose_resources(dev)
            if detached:
                dev.attach_kernel_driver(0)
        except Exception:
            pass


def main():
    result = {"ok": True, "hardware": None, "jobs": [], "errors": []}

    try:
        result["jobs"] = fetch_cups_jobs()
    except Exception as exc:
        result["errors"].append("CUPS: " + str(exc)[:200])

    try:
        result["hardware"] = fetch_usb_hardware()
    except Exception as exc:
        result["errors"].append("USB: " + str(exc)[:200])
        result["hardware"] = {"found": False, "online": False, "error": str(exc)[:200]}

    if result["errors"]:
        result["ok"] = len(result["jobs"]) > 0 or (
            result.get("hardware") and result["hardware"].get("found")
        )

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
