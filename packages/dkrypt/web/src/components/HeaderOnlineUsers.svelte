<script lang="ts">
  import { Users } from 'lucide-svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Popover from '#lib/components/ui/Popover.svelte';
  import { liveState } from '#lib/live.svelte';
  import { sessionState } from '#lib/session.svelte';

  const users = $derived(liveState.onlineUsers);
</script>

{#if users.length > 0}
  <Popover triggerClass="inline-flex">
    {#snippet trigger()}
      <Badge variant="secondary" title="Who's online">
        <Users class="mr-1 inline h-3 w-3" />
        {users.length} online
      </Badge>
    {/snippet}
    <div class="flex flex-col gap-1 whitespace-nowrap">
      {#each users as u (u.userId)}
        <div data-sensitive="true">{u.displayName}{u.userId === sessionState.sub ? ' (you)' : ''}</div>
      {/each}
    </div>
  </Popover>
{/if}
