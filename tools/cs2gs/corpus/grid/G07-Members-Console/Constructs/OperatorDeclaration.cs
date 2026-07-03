// inventory: OperatorDeclaration — user-defined +, ==/!=, < and > operators
// QUARANTINED sub-probe: overriding Equals(object) with `obj is Money other && ...`
// compiles but fails ilverify (StackUnexpected: found address of 'object', expected
// readonly address of 'Money' in Money::Equals). The override is omitted; the C#
// build accepts CS0660/CS0661 warnings.
using System;

namespace Corpus.Grid07
{
    public struct Money
    {
        private readonly int _cents;

        public Money(int cents)
        {
            _cents = cents;
        }

        public int Cents()
        {
            return _cents;
        }

        public static Money operator +(Money left, Money right)
        {
            return new Money(left._cents + right._cents);
        }

        public static bool operator ==(Money left, Money right)
        {
            return left._cents == right._cents;
        }

        public static bool operator !=(Money left, Money right)
        {
            return left._cents != right._cents;
        }

        public static bool operator <(Money left, Money right)
        {
            return left._cents < right._cents;
        }

        public static bool operator >(Money left, Money right)
        {
            return left._cents > right._cents;
        }
    }

    public static class OperatorDeclarationFixture
    {
        public static void Run()
        {
            Money five = new Money(500);
            Money three = new Money(300);
            Money eight = five + three;
            Console.WriteLine("OperatorDeclaration: plus=" + eight.Cents().ToString());
            Console.WriteLine("OperatorDeclaration: equal=" + (eight == new Money(800) ? "true" : "false"));
            Console.WriteLine("OperatorDeclaration: not-equal=" + (five != three ? "true" : "false"));
            Console.WriteLine("OperatorDeclaration: less=" + (three < five ? "true" : "false"));
            Console.WriteLine("OperatorDeclaration: greater=" + (three > five ? "true" : "false"));
        }
    }
}
