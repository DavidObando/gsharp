// inventory: Attribute — generic attribute class applied with a type argument
// (C#11 probe, issue #1913 fixed). The applied instance is read back via
// reflection (as `TagAttribute<int>`) and its `KindName()` (`typeof(T).Name`)
// exercised, so the emitted G# generic attribute really closed the type
// argument rather than silently keeping the open generic definition.
using System;
using System.Linq;

namespace Corpus.Grid08
{
    [AttributeUsage(AttributeTargets.All)]
    public sealed class TagAttribute<T> : Attribute
    {
        public string KindName()
        {
            return typeof(T).Name;
        }
    }

    [Tag<int>]
    public class TaggedCrate
    {
        public int Weight()
        {
            return 30;
        }
    }

    public static class GenericAttributeFixture
    {
        public static void Run()
        {
            TaggedCrate crate = new TaggedCrate();
            Console.WriteLine("GenericAttribute: weight=" + crate.Weight().ToString());

            TagAttribute<int> tag = typeof(TaggedCrate).GetCustomAttributes(true)
                .OfType<TagAttribute<int>>()
                .First();
            Console.WriteLine("GenericAttribute: kind=" + tag.KindName());
        }
    }
}
