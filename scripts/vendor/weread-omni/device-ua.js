/** The public package's single, stable e-ink device identity. */
export function einkDevice() {
    return {
        userAgent: "WeRead/2.1.2 WRBrand/Onyx wr_eink Dalvik/2.1.0 (Linux; U; Android 11; BOOX Build/onyx)",
        baseapi: "30",
        appver: "2.1.2.10245900",
        osver: "11",
        channelId: "900",
        deviceName: "BOOX",
        wrbrand: "Onyx",
    };
}
export function deviceVersionHeaders(device) {
    return {
        baseapi: device.baseapi,
        appver: device.appver,
        basever: device.appver,
        osver: device.osver,
        channelId: device.channelId,
        "User-Agent": device.userAgent,
    };
}
