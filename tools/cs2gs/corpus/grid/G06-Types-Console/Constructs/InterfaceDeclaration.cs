// inventory: InterfaceDeclaration — interface methods + properties, default interface method (probe)
using System;

namespace Corpus.Grid06
{
    public interface IMeasurable
    {
        int Length { get; }

        string Describe();
    }

    public class Rope : IMeasurable
    {
        private readonly int _length;

        public Rope(int length)
        {
            _length = length;
        }

        public int Length
        {
            get { return _length; }
        }

        public string Describe()
        {
            return "rope of " + _length.ToString();
        }
    }

    public interface IWithDefault
    {
        int Seed();

        int DoubledSeed()
        {
            return Seed() * 2;
        }
    }

    public class SeedSource : IWithDefault
    {
        public int Seed()
        {
            return 21;
        }
    }

    public static class InterfaceDeclarationFixture
    {
        public static void Run()
        {
            IMeasurable rope = new Rope(12);
            Console.WriteLine("InterfaceDeclaration: length=" + rope.Length.ToString());
            Console.WriteLine("InterfaceDeclaration: describe=" + rope.Describe());

            IWithDefault seeded = new SeedSource();
            Console.WriteLine("InterfaceDeclaration: default-method=" + seeded.DoubledSeed().ToString());
        }
    }
}
