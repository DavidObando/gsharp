// file: ClosureCaptureRefTypeField.gs
// Issue #567 regression repro: a closure captures a reference-type local and
// reads a field on it. Today (pre-fix) this fails with GS9998 at (1,1,1,1);
// once #567 lands the gate will catch any silent IL change in the fix.

package GSharp.Refactoring.ClosureCaptureRefTypeField

import System

type Holder class {
    var Value int32
    init() {}
}

func run() int32 {
    var h = Holder()
    h.Value = 42
    var getter = func() int32 { return h.Value }
    return getter()
}

Console.WriteLine(run())
