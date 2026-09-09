// ITouchProxy.aidl — implemented by TouchProxyService, which runs inside the Shizuku user-service process (shell uid).
package com.devicerelay.client.shizuku;

interface ITouchProxy {
    /** diagnostics: device path/name, raw ranges, bitness, mapping */
    String describe() = 1;
    /** true when the kernel touch device is open read+write and the reader thread is alive */
    boolean isReady() = 2;
    /** display mapping: rotation = Surface.ROTATION_*, dispW/dispH = display size in the CURRENT rotation (= screenshot bitmap size) */
    void setMapping(int rotation, int dispW, int dispH) = 3;
    /** real fingers currently down (ours excluded): [slot, x, y, heldMs, slot, x, y, heldMs, ...] in display px */
    int[] touches() = 4;
    /** ms since the last real touch event */
    long lastEventAgeMs() = 5;
    /** put OUR finger down at display px (own MT slot inside the real touchscreen stream). bindSlot: real slot whose lift auto-lifts ours (-1 = none) */
    boolean fingerDown(int x, int y, int bindSlot) = 6;
    /** move our finger to absolute display px */
    boolean fingerMove(int x, int y) = 7;
    /** lift our finger */
    void fingerUp() = 8;
    boolean fingerIsDown() = 9;
    /** [downs, moves, readEvents, writeErrors, reinjects] */
    long[] counters() = 10;
    void destroy() = 16777114;
}
