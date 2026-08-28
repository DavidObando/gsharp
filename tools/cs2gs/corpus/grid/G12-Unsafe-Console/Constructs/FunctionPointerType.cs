// inventory: FunctionPointerType — also FunctionPointerParameter and the managed calling convention (probe)
// Managed function pointers: `delegate*<int, int>` and an explicit
// `delegate* managed<int, int, int>`, taken with & and invoked directly.
// ADR-0095 v2 / issue #3611: the open CLR calling-convention model — a bare
// `delegate* unmanaged<...>` (platform-default ABI) and combined CallConv
// sets are declarable type shapes; they cannot be invoked without a native
// target, so the fixture only declares and null-tests them.
using System;

namespace Corpus.Grid12.Constructs
{
    public static class FunctionPointerTypeFixture
    {
        private static unsafe delegate* unmanaged<int, int> bareUnmanagedSlot;
        private static unsafe delegate* unmanaged[Cdecl, SuppressGCTransition]<int, int> combinedConventionSlot;

        public static void Run()
        {
            unsafe
            {
                delegate*<int, int> square = &Square;
                Console.WriteLine($"FunctionPointerType: square(6)={square(6)}");

                delegate* managed<int, int, int> add = &Add;
                Console.WriteLine($"FunctionPointerType: add(3,4)={add(3, 4)}");

                bareUnmanagedSlot = null;
                combinedConventionSlot = null;
                Console.WriteLine($"FunctionPointerType: bareUnmanagedNull={bareUnmanagedSlot == null}");
                Console.WriteLine($"FunctionPointerType: combinedConventionNull={combinedConventionSlot == null}");
            }
        }

        private static int Square(int value)
        {
            return value * value;
        }

        private static int Add(int left, int right)
        {
            return left + right;
        }
    }
}
