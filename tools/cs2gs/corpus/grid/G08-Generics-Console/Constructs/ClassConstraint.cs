// inventory: ClassConstraint — where T : class
// Issue #1920 (fixed): a ctor that only does once-only parameter assignments
// is lowered to a G# primary ctor. Previously, instantiating a GENERIC
// primary-ctor class from inside another class's static/instance method ICEd
// gsc (GS9998 "Type 'RefKeeper' has no emitted primary ctor.") because the
// ctor MemberRef lookup was keyed off the constructed StructSymbol instead of
// its open definition. Kept as a trivial passthrough ctor (no transform) to
// exercise the primary-ctor emission path directly.
using System;

namespace Corpus.Grid08
{
    public sealed class RefKeeper<T>
        where T : class
    {
        private readonly T _kept;
        private readonly int _tag;

        public RefKeeper(T kept, int seed)
        {
            _kept = kept;
            _tag = seed;
        }

        public T Kept()
        {
            return _kept;
        }

        public int Tag()
        {
            return _tag;
        }
    }

    public static class ClassConstraintFixture
    {
        public static void Run()
        {
            RefKeeper<string> keeper = new RefKeeper<string>("pinned", 0);
            Console.WriteLine("ClassConstraint: kept=" + keeper.Kept());
            Console.WriteLine("ClassConstraint: tag=" + keeper.Tag().ToString());
        }
    }
}
