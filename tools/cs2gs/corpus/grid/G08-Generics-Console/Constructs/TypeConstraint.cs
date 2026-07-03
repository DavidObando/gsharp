// inventory: TypeConstraint — where T : BaseClass and where T : IInterface
using System;

namespace Corpus.Grid08
{
    public class Creature
    {
        public virtual string Sound()
        {
            return "...";
        }
    }

    public class Frog : Creature
    {
        public override string Sound()
        {
            return "ribbit";
        }
    }

    public interface INamed
    {
        string Name();
    }

    public class NamedFrog : Frog, INamed
    {
        public string Name()
        {
            return "kermit";
        }
    }

    public static class ConstraintCalls
    {
        public static string Hear<T>(T creature)
            where T : Creature
        {
            return creature.Sound();
        }

        public static string Call<T>(T named)
            where T : INamed
        {
            return named.Name();
        }
    }

    public static class TypeConstraintFixture
    {
        public static void Run()
        {
            Console.WriteLine("TypeConstraint: base=" + ConstraintCalls.Hear(new Frog()));
            Console.WriteLine("TypeConstraint: interface=" + ConstraintCalls.Call(new NamedFrog()));
        }
    }
}
