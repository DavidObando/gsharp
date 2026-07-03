// inventory: PropertyDeclaration — auto get/set, get-only, computed (arrow), private set
using System;

namespace Corpus.Grid07
{
    public class Thermostat
    {
        public Thermostat(string room)
        {
            Room = room;
            Target = 20;
        }

        public int Target { get; set; }

        public string Room { get; }

        public int TargetPlusOne => Target + 1;

        public int Adjustments { get; private set; }

        public void Nudge(int delta)
        {
            Target = Target + delta;
            Adjustments = Adjustments + 1;
        }
    }

    public static class PropertyDeclarationFixture
    {
        public static void Run()
        {
            Thermostat stat = new Thermostat("study");
            stat.Target = 22;
            stat.Nudge(3);
            Console.WriteLine("PropertyDeclaration: room=" + stat.Room);
            Console.WriteLine("PropertyDeclaration: target=" + stat.Target.ToString());
            Console.WriteLine("PropertyDeclaration: computed=" + stat.TargetPlusOne.ToString());
            Console.WriteLine("PropertyDeclaration: adjustments=" + stat.Adjustments.ToString());
        }
    }
}
