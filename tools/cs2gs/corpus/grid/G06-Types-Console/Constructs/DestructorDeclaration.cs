// inventory: DestructorDeclaration — finalizer declared (probe); parity output printed from Run, never from the finalizer
using System;

namespace Corpus.Grid06
{
    public class EphemeralResource
    {
        private readonly int _id;

        public EphemeralResource(int id)
        {
            _id = id;
        }

        public int Id()
        {
            return _id;
        }

        ~EphemeralResource()
        {
            // Deliberately empty: finalizer timing is nondeterministic, so it
            // must not write to stdout. The declaration itself is the probe.
        }
    }

    public static class DestructorDeclarationFixture
    {
        public static void Run()
        {
            EphemeralResource resource = new EphemeralResource(7);
            Console.WriteLine("DestructorDeclaration: declared, id=" + resource.Id().ToString());
        }
    }
}
