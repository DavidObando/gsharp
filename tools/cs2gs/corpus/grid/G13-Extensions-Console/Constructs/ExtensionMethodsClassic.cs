// inventory: MethodDeclaration — classic `this`-parameter extension methods
// Extension methods on BCL types (string, int) and on a user type, including
// a chained call of the same extension.
using System;

namespace Corpus.Grid13.Constructs
{
    public sealed class Box
    {
        public Box(int value)
        {
            Value = value;
        }

        public int Value { get; }
    }

    public static class ClassicExtensions
    {
        public static string Bracketed(this string value)
        {
            return "[" + value + "]";
        }

        public static int Squared(this int value)
        {
            return value * value;
        }

        public static int Doubled(this Box box)
        {
            return box.Value * 2;
        }
    }

    public static class ExtensionMethodsClassicFixture
    {
        public static void Run()
        {
            Console.WriteLine($"ExtensionMethodsClassic: bracketed={"hi".Bracketed()}");

            // Issue #1883: an extension method invoked directly on an int
            // literal (`7.Squared()`) must translate to a parenthesized
            // receiver (`(7).Squared()`) — G#'s grammar never chains postfix
            // access onto a bare numeric-literal token (ADR-0054), so an
            // unparenthesized `7.Squared()` fails to parse (GS0005/GS0157).
            Console.WriteLine($"ExtensionMethodsClassic: squared={7.Squared()}");

            Box box = new Box(21);
            Console.WriteLine($"ExtensionMethodsClassic: userType={box.Doubled()}");

            Console.WriteLine($"ExtensionMethodsClassic: chained={"x".Bracketed().Bracketed()}");
        }
    }
}
