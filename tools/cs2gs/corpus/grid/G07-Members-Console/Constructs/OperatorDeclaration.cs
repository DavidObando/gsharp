// inventory: OperatorDeclaration — user-defined +, ==/!=, < and > operators
// Issue #1917 (fixed): an Equals(object) override using `obj is Money other &&
// ...` used to compile but fail ilverify (StackUnexpected: found address of
// 'object', expected readonly address of 'Money' in Money::Equals). The
// struct field-access emitter took the address of the ORIGINAL `object`-typed
// parameter slot instead of unboxing the smart-cast-narrowed value first. See
// MethodBodyEmitter.TryLoadStructVariableAddress.
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

        public override bool Equals(object? obj)
        {
            return obj is Money other && _cents == other._cents;
        }

        public override int GetHashCode()
        {
            return _cents.GetHashCode();
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

            object boxedEight = eight;
            Console.WriteLine("OperatorDeclaration: equals-override=" + (boxedEight.Equals(new Money(800)) ? "true" : "false"));
            Console.WriteLine("OperatorDeclaration: equals-override-mismatch=" + (boxedEight.Equals("not money") ? "true" : "false"));
        }
    }
}
