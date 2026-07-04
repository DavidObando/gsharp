// inventory: ClassDeclaration — partial class, part 2 of 2 (issue #1910).
using System;

namespace Corpus.Grid06
{
    public partial class Ledger
    {
        public void Withdraw(int amount)
        {
            _balance = _balance - amount;
        }

        public int Balance()
        {
            return _balance;
        }
    }
}
