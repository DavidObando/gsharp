// inventory: IndexerDeclaration — this[int] with get and set backed by an array
using System;

namespace Corpus.Grid07
{
    public class SlotRack
    {
        private readonly int[] _slots;

        public SlotRack(int size)
        {
            _slots = new int[size];
        }

        public int this[int index]
        {
            get { return _slots[index]; }
            set { _slots[index] = value; }
        }
    }

    public static class IndexerDeclarationFixture
    {
        public static void Run()
        {
            SlotRack rack = new SlotRack(4);
            rack[0] = 11;
            rack[3] = 44;
            rack[0] = rack[0] + 1;
            Console.WriteLine("IndexerDeclaration: slot0=" + rack[0].ToString());
            Console.WriteLine("IndexerDeclaration: slot3=" + rack[3].ToString());
            Console.WriteLine("IndexerDeclaration: slot1=" + rack[1].ToString());
        }
    }
}
