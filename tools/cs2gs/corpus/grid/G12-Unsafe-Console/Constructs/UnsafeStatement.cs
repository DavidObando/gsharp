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
using System;

namespace Corpus.Grid12.Constructs
{
    internal struct UnsafeMarker
    {
        public long Ticks;
        public int Kind;
    }

    public static class UnsafeStatementFixture
    {
        public static void Run()
        {
            UnsafeMarker marker;
            marker.Ticks = 40L;
            marker.Kind = 2;
            unsafe
            {
                int markerSize = sizeof(UnsafeMarker);
                Console.WriteLine($"UnsafeStatement: block markerSize={markerSize} tag={marker.Ticks + marker.Kind}");
            }

            Console.WriteLine($"UnsafeStatement: method result={UnsafeScale(21)}");
        }

        private static unsafe int UnsafeScale(int value)
        {
            int units = sizeof(long) / sizeof(int);
            return value * units;
        }
    }
}
