// inventory: FieldDeclaration — const, readonly, static, and instance fields
using System;

namespace Corpus.Grid07
{
    public class FieldHolder
    {
        public const int MaxSlots = 64;

        public static int SharedCount = 5;

        private readonly int _fixedSeed;

        private int _mutable;

        public FieldHolder(int seed)
        {
            _fixedSeed = seed;
            _mutable = 1;
        }

        public void Grow()
        {
            _mutable = _mutable + _fixedSeed;
        }

        public int Mutable()
        {
            return _mutable;
        }
    }

    public static class FieldDeclarationFixture
    {
        public static void Run()
        {
            Console.WriteLine("FieldDeclaration: const=" + FieldHolder.MaxSlots.ToString());
            Console.WriteLine("FieldDeclaration: static=" + FieldHolder.SharedCount.ToString());
            FieldHolder.SharedCount = FieldHolder.SharedCount + 2;
            Console.WriteLine("FieldDeclaration: static-bumped=" + FieldHolder.SharedCount.ToString());

            FieldHolder holder = new FieldHolder(10);
            holder.Grow();
            holder.Grow();
            Console.WriteLine("FieldDeclaration: mutable=" + holder.Mutable().ToString());
        }
    }
}
