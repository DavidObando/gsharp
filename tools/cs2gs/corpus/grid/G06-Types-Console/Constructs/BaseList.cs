// inventory: BaseList — class inheritance, virtual/override, base.M() (probe)
using System;

namespace Corpus.Grid06
{
    public class Animal
    {
        public virtual string Speak()
        {
            return "generic";
        }

        public string Intro()
        {
            return "animal says " + Speak();
        }
    }

    public class Dog : Animal
    {
        public override string Speak()
        {
            return "woof (was " + base.Speak() + ")";
        }
    }

    public static class BaseListFixture
    {
        public static void Run()
        {
            Animal plain = new Animal();
            Animal dog = new Dog();
            Console.WriteLine("BaseList: plain=" + plain.Speak());
            Console.WriteLine("BaseList: dog=" + dog.Speak());
            Console.WriteLine("BaseList: intro=" + dog.Intro());
        }
    }
}
