// inventory: StructConstraint — where T : struct
// Note: the `_tag = seed + 2` transformed-parameter assignment prevents the generic-primary-ctor gsc ICE (GS9998,
// see ClassConstraint.cs).
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
            _tag = seed + 2;
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
