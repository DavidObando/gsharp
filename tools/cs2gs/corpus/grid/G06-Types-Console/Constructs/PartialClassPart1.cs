// inventory: ClassDeclaration — partial class, part 1 of 2 (issue #1910: cs2gs
// merges every partial declaration into one G# type; verified by baseline
// stdout parity below).
using System;

namespace Corpus.Grid06
{
    public partial class Ledger
    {
        private int _balance;

        public void Deposit(int amount)
        {
            _balance = _balance + amount;
        }
    }

    public static class PartialClassFixture
    {
        public static void Run()
        {
            Ledger ledger = new Ledger();
            ledger.Deposit(40);
            ledger.Withdraw(15);
            Console.WriteLine("PartialClass: balance=" + ledger.Balance().ToString());
        }
    }
}
