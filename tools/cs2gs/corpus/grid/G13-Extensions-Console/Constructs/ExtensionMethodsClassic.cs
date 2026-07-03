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

            // NOTE: `7.Squared()` (extension invoked directly on an int
            // literal) is avoided on purpose: the emitted G# `7.Squared()`
            // does not round-trip (`7.` lexes as a float literal; GS0005/
            // GS0157). A named local receiver works.
            int seven = 7;
            Console.WriteLine($"ExtensionMethodsClassic: squared={seven.Squared()}");

            Box box = new Box(21);
            Console.WriteLine($"ExtensionMethodsClassic: userType={box.Doubled()}");

            Console.WriteLine($"ExtensionMethodsClassic: chained={"x".Bracketed().Bracketed()}");
        }
    }
}
