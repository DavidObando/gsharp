// inventory: MethodDeclaration — instance, static, virtual/override, and `new` hiding (probe)
using System;

namespace Corpus.Grid07
{
    public class Speaker
    {
        public virtual string Voice()
        {
            return "base-voice";
        }

        public string Twice()
        {
            return Voice() + "+" + Voice();
        }

        public string Label()
        {
            return "speaker";
        }
    }

    public class LoudSpeaker : Speaker
    {
        public override string Voice()
        {
            return "LOUD";
        }

        public new string Label()
        {
            return "loudspeaker";
        }
    }

    public static class MethodDeclarationFixture
    {
        public static int Add(int left, int right)
        {
            return left + right;
        }

        public static void Run()
        {
            Console.WriteLine("MethodDeclaration: static=" + Add(19, 23).ToString());

            LoudSpeaker loud = new LoudSpeaker();
            Speaker asBase = loud;
            Console.WriteLine("MethodDeclaration: virtual=" + asBase.Voice());
            Console.WriteLine("MethodDeclaration: twice=" + asBase.Twice());
            Console.WriteLine("MethodDeclaration: hide-base=" + asBase.Label());
            Console.WriteLine("MethodDeclaration: hide-derived=" + loud.Label());
        }
    }
}
