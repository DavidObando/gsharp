// inventory: ScopedType — scoped ref-struct local and a scoped ref parameter (probe)
// A `scoped Span<int>` local (ref struct usage) built over an array — not
// stackalloc, whose localloc IL is unverifiable (stage 3) even when csc
// compiles it — plus a method taking `scoped ref int`.

package Corpus.Grid12.Constructs

import System

shared class ScopedTypeFixture {
    func Run() {
        let data = []int32{1, 2, 3}
        let buffer = Span[int32](data)
        var window = buffer.Slice(1)
        window[0] = 7
        Console.WriteLine("ScopedType: data=${data[0]},${data[1]},${data[2]}")
        var local = 5
        Bump(&local)
        Console.WriteLine("ScopedType: bumped=$local")
    }

    private func Bump(ref value int32) {
        value += 1
    }
}
