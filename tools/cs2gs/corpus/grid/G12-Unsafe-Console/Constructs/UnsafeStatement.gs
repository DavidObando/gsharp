// inventory: UnsafeStatement — unsafe blocks and an unsafe method (pointer-free bodies)
// The `unsafe { ... }` block and the method-level `unsafe` modifier survive
// end-to-end only with verifiable bodies: pointer IL fails stage 3 (ILVerify)
// even when compiled by csc, so the bodies use sizeof over user structs (the
// verifiable `sizeof` opcode) instead of pointer dereferences.
//
// QUARANTINED facet: pointer work inside unsafe contexts. Original snippet
// (compiles with gsc, runs correctly, but ILVerify reports UnmanagedPointer/
// StackByRef/ExpectedNumericType — also on the csc-compiled baseline):
//
//     unsafe
//     {
//         int value = 12;
//         int* p = &value;
//         Console.WriteLine($"UnsafeStatement: block value={*p}");
//     }

package Corpus.Grid12.Constructs

import System

internal struct UnsafeMarker {
    var Ticks int64
    var Kind int32
}

shared class UnsafeStatementFixture {
    func Run() {
        var marker UnsafeMarker
        marker.Ticks = 40L
        marker.Kind = 2
        unsafe {
            let markerSize = sizeof(UnsafeMarker)
            Console.WriteLine("UnsafeStatement: block markerSize=$markerSize tag=${marker.Ticks + int64(marker.Kind)}")
        }
        Console.WriteLine("UnsafeStatement: method result=${UnsafeScale(21)}")
    }

    private func UnsafeScale(value int32) int32 {
        unsafe {
            let units = 8 / 4
            return value * units
        }
    }
}
