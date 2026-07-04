// inventory: TypeParameter — declaration-site variance: covariant (out) and contravariant (in) interfaces (probe)
// Note: in/out variance on DELEGATES is not exercised here because DelegateDeclaration
// itself is CS2GS-GAP (see G07 Quarantined/EventDeclaration.cs.txt).
using System;

namespace Corpus.Grid08
{
    public interface ISource<out T>
    {
        T Get();
    }

    public interface ISink<in T>
    {
        string Accept(T value);
    }

    public class StringSource : ISource<string>
    {
        public string Get()
        {
            return "made";
        }
    }

    public class ObjectSink : ISink<object>
    {
        public string Accept(object value)
        {
            return "took:" + value.ToString();
        }
    }

    public static class TypeParameterFixture
    {
        public static void Run()
        {
            ISource<string> source = new StringSource();
            ISource<object> widened = source;
            Console.WriteLine("TypeParameter: covariant=" + widened.Get().ToString());

            ISink<object> sink = new ObjectSink();
            ISink<string> narrowed = sink;
            Console.WriteLine("TypeParameter: contravariant=" + narrowed.Accept("note"));
        }
    }
}
