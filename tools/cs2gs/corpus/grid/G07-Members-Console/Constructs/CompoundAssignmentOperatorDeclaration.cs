// inventory: OperatorDeclaration — C#14 user-defined instance compound assignment
// operator += has no canonical G# form (G# operator declarations are
// binary/unary only, ADR-0035); the translator reports this as a loud
// CS2GS-GAP (issue #1908) instead of emitting `operator +=`, which fails
// round-trip parse (GS0005). Tracked as a known/open gap in
// tools/cs2gs/triage/gaps.json so the corpus sanity check tolerates it.
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
