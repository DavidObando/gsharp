// inventory: ClassConstraint — where T : class
// QUARANTINED sub-probe: a generic class whose ctor only does once-only parameter
// assignments is lowered to a G# primary ctor, and instantiating a GENERIC primary-
// ctor class ICEs gsc (GS9998 InvalidOperationException: Type 'RefKeeper' has no
// emitted primary ctor — reproduced with hand-written G#). The `_tag = seed + 1`
// transformed-parameter assignment forces the translator to emit an explicit init
// ctor instead (a plain literal is hoisted to a field initializer and still ICEs).
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
            _tag = seed + 1;
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
