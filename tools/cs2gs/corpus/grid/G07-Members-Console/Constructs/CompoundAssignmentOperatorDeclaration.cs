// inventory: OperatorDeclaration — C#14 user-defined instance compound assignment
// operator +=. gsc issue #2834 gave this a canonical G# spelling as an ordinary
// in-body member (`public func operator +=(amount int32) { ... }`), which emits
// the same instance, void-returning, specialname `op_AdditionAssignment` method
// Roslyn produces, so the construct round-trips end to end (translate, compile,
// ilverify, stdout parity) instead of being a tracked CS2GS-GAP.
using System;

namespace Corpus.Grid07
{
    public class TallyBag
    {
        private int _total;

        public TallyBag(int start)
        {
            _total = start;
        }

        public void operator +=(int amount)
        {
            _total = _total + amount;
        }

        public int Total()
        {
            return _total;
        }
    }

    public static class CompoundAssignmentOperatorDeclarationFixture
    {
        public static void Run()
        {
            TallyBag bag = new TallyBag(10);
            bag += 5;
            bag += 7;
            Console.WriteLine("CompoundAssignmentOperatorDeclaration: total=" + bag.Total().ToString());
        }
    }
}
