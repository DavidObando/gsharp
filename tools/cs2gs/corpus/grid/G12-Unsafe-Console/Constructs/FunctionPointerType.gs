// inventory: FunctionPointerType — also FunctionPointerParameter and the managed calling convention (probe)
// Managed function pointers: `delegate*<int, int>` and an explicit
// `delegate* managed<int, int, int>`, taken with & and invoked directly.
// ADR-0095 v2 / issue #3611: the open CLR calling-convention model — a bare
// `delegate* unmanaged<...>` (platform-default ABI) and combined CallConv
// sets are declarable type shapes; they cannot be invoked without a native
// target, so the fixture only declares and null-tests them.

package Corpus.Grid12.Constructs

import System

shared class FunctionPointerTypeFixture {
    private var bareUnmanagedSlot unmanaged(int32) -> int32
    private var combinedConventionSlot unmanaged[Cdecl, SuppressGCTransition](int32) -> int32

    func Run() {
        unsafe {
            let square *func (int32) int32 = &Square
            Console.WriteLine("FunctionPointerType: square(6)=${square(6)}")
            let add *func (int32, int32) int32 = &Add
            Console.WriteLine("FunctionPointerType: add(3,4)=${add(3, 4)}")
            bareUnmanagedSlot = nil
            combinedConventionSlot = nil
            Console.WriteLine("FunctionPointerType: bareUnmanagedNull=${bareUnmanagedSlot == nil}")
            Console.WriteLine("FunctionPointerType: combinedConventionNull=${combinedConventionSlot == nil}")
        }
    }

    private func Square(value int32) int32 {
        return value * value
    }

    private func Add(left int32, right int32) int32 {
        return left + right
    }
}
