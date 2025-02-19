module.exports = async function donorCheck() {
  const serversPerPage = 50;
  const checksToFailBeforeDeletion = 7;

  if (!process.env.CSMM_DONOR_ONLY) {
    return;
  }


  const serverCount = await SdtdServer.count();
  sails.log.debug(`[Donor check] ${serverCount} servers in the system to check`);

  for (let i = 0; i < serverCount / serversPerPage; i++) {
    const serversToCheck = await SdtdServer.find({
      skip: serversPerPage * i,
      limit: serversPerPage,
    });

    for (const server of serversToCheck) {
      try {
        const donorStatus = await sails.helpers.meta.checkDonatorStatus(server.id);

        if (donorStatus !== 'free') {
          sails.log.debug(`[Donor check] server ${server.id} is a donator! Yay`, { server });
          await SdtdConfig.update({ server: server.id }, { failedDonorChecks: 0 });
          continue;
        }

        let current = await SdtdConfig.findOne({ server: server.id });
        current = (await SdtdConfig.update({ server: server.id }, { failedDonorChecks: current.failedDonorChecks + 1 }).fetch())[0];

        const user = await User.findOne(server.owner);
        sails.log.warn(`[Donor check] server ${server.id} failed donator check. Has failed ${current.failedDonorChecks} times so far. Sending a DM to user ${user.id}`, { server });

        try {
          await sails.helpers.discord.sendDm(user.discordId, `WARNING! The CSMM instance you are using is a donator-only instance. CSMM checks your donator status every day and if your server fails ${checksToFailBeforeDeletion} times, it will be automatically deleted. This is check ${current.failedDonorChecks}/${checksToFailBeforeDeletion} for server ${server.id}. If this is not correct please contact support as soon as possible. If the maximum checks are reached, your server data will be deleted WITHOUT ANY CHANCE OF RECOVERY`);
        } catch (error) {
          sails.log.warn(`[Donor check] Failed to send a DM to a user`, { user, server });
        }


        if (current.failedDonorChecks >= checksToFailBeforeDeletion) {
          sails.log.info(`[Donor check] server ${server.id} has failed too many times, deleting the server from the system :(.`, { server });
          await destroyServer(server);
        }
      } catch (error) {
        sails.log.error(error, { server });
        continue;
      }
    }
  }
};

async function destroyServer(server) {
  await Analytics.destroy({
    server: server.id
  });

  await HistoricalInfo.destroy({
    server: server.id
  });

  await TrackingInfo.destroy({
    server: server.id
  });


  await SdtdServer.update({ id: server.id }, { disabled: true });
}
