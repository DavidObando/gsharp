// inventory: ScopedType — scoped ref-struct local and a scoped ref parameter (probe)
// A `scoped Span<int>` local (ref struct usage) built over an array — not
// stackalloc, whose localloc IL is unverifiable (stage 3) even when csc
// compiles it — plus a method taking `scoped ref int`.
using System;

namespace Corpus.Grid12.Constructs
{
    public static class ScopedTypeFixture
    {
        public static void Run()
        {
            int[] data = new int[] { 1, 2, 3 };
            Span<int> buffer = new Span<int>(data);

            scoped Span<int> window = buffer.Slice(1);
            window[0] = 7;
            Console.WriteLine($"ScopedType: data={data[0]},{data[1]},{data[2]}");

            int local = 5;
            Bump(ref local);
            Console.WriteLine($"ScopedType: bumped={local}");
        }

        private static void Bump(scoped ref int value)
        {
            value += 1;
        }
    }
}
