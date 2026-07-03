// inventory: PrimaryConstructorBaseType — primary constructor on plain class (C#12 probe) + derived : Base(arg)
using System;

namespace Corpus.Grid06
{
    public class NamedItem(string name)
    {
        public string Name()
        {
            return name;
        }
    }

    public class PricedItem(string name, int price) : NamedItem(name)
    {
        public int Price()
        {
            return price;
        }
    }

    public static class PrimaryConstructorBaseTypeFixture
    {
        public static void Run()
        {
            NamedItem item = new NamedItem("widget");
            Console.WriteLine("PrimaryConstructorBaseType: name=" + item.Name());

            PricedItem priced = new PricedItem("gadget", 25);
            Console.WriteLine("PrimaryConstructorBaseType: derived=" + priced.Name() + "/" + priced.Price().ToString());
        }
    }
}
