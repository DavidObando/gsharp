// inventory: TypeParameterList — generic class, interface, and method declarations
// QUARANTINED sub-probes:
//   * a generic STRUCT (`struct Slot<T>` with `_content = content` in its ctor)
//     fails translate with CS2GS-GAP "struct constructor assigns a member from
//     something other than a plain, once-only parameter reference" — the same
//     pattern on non-generic structs passes (G06 StructDeclaration).
// gsc issue #1932 (fixed): calling a generic method with an INFERRED type
// argument over a user generic type (`Swapper.Swap(pair)`) used to fail with
// GS0151 "Cannot infer type argument 'T'" even though the explicit form
// `Swapper.Swap<string>(pair)` worked; both forms are exercised below now.
using System;

namespace Corpus.Grid08
{
    public interface IPairView<T>
    {
        T First();
    }

    public class Pair<T> : IPairView<T>
    {
        private readonly T _first;
        private readonly T _second;
        private readonly int _size;

        public Pair(T first, T second, int seed)
        {
            _first = first;
            _second = second;
            _size = seed + 2;
        }

        public int Size()
        {
            return _size;
        }

        public T First()
        {
            return _first;
        }

        public T Second()
        {
            return _second;
        }
    }

    public static class Swapper
    {
        public static Pair<T> Swap<T>(Pair<T> pair)
        {
            return new Pair<T>(pair.Second(), pair.First(), 0);
        }
    }

    public static class TypeParameterListFixture
    {
        public static void Run()
        {
            Pair<string> pair = new Pair<string>("left", "right", 0);
            Console.WriteLine("TypeParameterList: first=" + pair.First());

            Pair<string> swapped = Swapper.Swap<string>(pair);
            Console.WriteLine("TypeParameterList: swapped-first=" + swapped.First());

            Pair<string> inferredSwapped = Swapper.Swap(pair);
            Console.WriteLine("TypeParameterList: inferred-swapped-first=" + inferredSwapped.First());

            IPairView<string> view = pair;
            Console.WriteLine("TypeParameterList: interface-first=" + view.First());
            Console.WriteLine("TypeParameterList: size=" + pair.Size().ToString());
        }
    }
}
