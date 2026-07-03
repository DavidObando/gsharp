// inventory: ConversionOperatorDeclaration — implicit and explicit user-defined conversions
using System;

namespace Corpus.Grid07
{
    public struct Meters
    {
        private readonly int _count;

        public Meters(int count)
        {
            _count = count;
        }

        public static implicit operator Meters(int count)
        {
            return new Meters(count);
        }

        public static explicit operator int(Meters meters)
        {
            return meters._count;
        }
    }

    public static class ConversionOperatorDeclarationFixture
    {
        public static void Run()
        {
            Meters distance = 42;
            int raw = (int)distance;
            Console.WriteLine("ConversionOperatorDeclaration: implicit-then-explicit=" + raw.ToString());

            Meters more = (Meters)7;
            Console.WriteLine("ConversionOperatorDeclaration: roundtrip=" + ((int)more).ToString());
        }
    }
}
