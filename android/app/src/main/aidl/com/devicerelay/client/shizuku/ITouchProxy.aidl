// ITouchProxy.aidl — implemented by TouchProxyService, which runs inside the Shizuku user-service process (shell uid).
package com.devicerelay.client.shizuku;

interface ITouchProxy {
    /** diagnostics: device path/name, raw ranges, bitness, mapping */
    String describe();
    /** true when the kernel touch device is open read+write and the reader thread is alive */
    boolean isReady();
    /** display mapping: rotation = Surface.ROTATION_*, dispW/dispH = display size in the CURRENT rotation (= screenshot bitmap size) */
    void setMapping(int rotation, int dispW, int dispH);
    /** real fingers currently down (ours excluded): [slot, x, y, heldMs, slot, x, y, heldMs, ...] in display px */
    int[] touches();
    /** ms since the last real touch event */
    long lastEventAgeMs();
    /** put OUR finger down at display px (own MT slot inside the real touchscreen stream). bindSlot: real slot whose lift auto-lifts ours (-1 = none) */
    boolean fingerDown(int x, int y, int bindSlot);
    /** move our finger to absolute display px */
    boolean fingerMove(int x, int y);
    /** lift our finger */
    void fingerUp();
    boolean fingerIsDown();
    /** [downs, moves, readEvents, writeErrors, reinjects] */
    long[] counters();
    void destroy() = 16777114;
}
