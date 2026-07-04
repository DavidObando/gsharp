// inventory: InitAccessorDeclaration — init-only property set via object initializer (probe)
using System;

namespace Corpus.Grid07
{
    public class FrozenLabel
    {
        public string Text { get; init; } = "empty";
    }

    public static class InitAccessorDeclarationFixture
    {
        public static void Run()
        {
            FrozenLabel label = new FrozenLabel { Text = "sealed" };
            Console.WriteLine("InitAccessorDeclaration: text=" + label.Text);

            FrozenLabel fallback = new FrozenLabel();
            Console.WriteLine("InitAccessorDeclaration: default=" + fallback.Text);
        }
    }
}
