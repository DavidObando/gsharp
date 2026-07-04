// inventory: StructConstraint — where T : struct
// Issue #1920 (fixed): previously the `_tag = seed + 2` transform was needed to
// dodge the generic-primary-ctor gsc ICE (GS9998, see ClassConstraint.cs). Kept
// as a trivial passthrough ctor now that the fix lands, exercising the same
// primary-ctor path for a `struct` constraint.
using System;

namespace Corpus.Grid08
{
    public sealed class ValueCell<T>
        where T : struct
    {
        private readonly T _value;
        private readonly int _tag;

        public ValueCell(T value, int seed)
        {
            _value = value;
            _tag = seed;
        }

        public T Value()
        {
            return _value;
        }

        public int Tag()
        {
            return _tag;
        }
    }

    public static class StructConstraintFixture
    {
        public static void Run()
        {
            ValueCell<int> cell = new ValueCell<int>(64, 0);
            Console.WriteLine("StructConstraint: int=" + cell.Value().ToString());
            Console.WriteLine("StructConstraint: tag=" + cell.Tag().ToString());
        }
    }
}
