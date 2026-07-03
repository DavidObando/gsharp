// inventory: SimpleBaseType — base list mixing a base class and an interface
using System;

namespace Corpus.Grid06
{
    public interface ITagged
    {
        string Tag();
    }

    public class Widget
    {
        public virtual string Kind()
        {
            return "widget";
        }
    }

    public class Sprocket : Widget, ITagged
    {
        public override string Kind()
        {
            return "sprocket";
        }

        public string Tag()
        {
            return "tag-" + Kind();
        }
    }

    public static class SimpleBaseTypeFixture
    {
        public static void Run()
        {
            Sprocket sprocket = new Sprocket();
            Widget asWidget = sprocket;
            ITagged asTagged = sprocket;
            Console.WriteLine("SimpleBaseType: kind=" + asWidget.Kind());
            Console.WriteLine("SimpleBaseType: tag=" + asTagged.Tag());
        }
    }
}
